package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

const (
	registryTransportTLS           = "tls"
	registryTransportTLSSkipVerify = "tlsSkipVerify"
	registryTransportTLSCustomCA   = "tlsCustomCA"
	registryTransportPlaintext     = "plaintext"
)

// registryTransportMode 把空值当成标准 TLS，其余只接受四种固定模式。
func registryTransportMode(value string) (string, bool) {
	switch strings.TrimSpace(value) {
	case "":
		return registryTransportTLS, true
	case registryTransportTLS, registryTransportTLSSkipVerify, registryTransportTLSCustomCA, registryTransportPlaintext:
		return strings.TrimSpace(value), true
	default:
		return "", false
	}
}

func registrySchemeMatches(mode, scheme string) bool {
	if mode == registryTransportPlaintext {
		return scheme == "http"
	}
	return scheme == "https"
}

// validatedRegistryURL 确认地址形态，以及 scheme 与传输模式一致。
// 不一致时原样报错，不改写地址。
func validatedRegistryURL(source ImageSource) (*url.URL, error) {
	raw, ok := normalizeRegistryURL(source.RegistryURL)
	if !ok {
		return nil, userError("errors.image.registryURLInvalid")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return nil, userError("errors.image.registryURLInvalid")
	}
	mode, ok := registryTransportMode(source.RegistryTransport)
	if !ok {
		return nil, userError("errors.config.registryTransportInvalid")
	}
	if !registrySchemeMatches(mode, parsed.Scheme) {
		return nil, userError("errors.config.registryURLSchemeMismatch")
	}
	return parsed, nil
}

func registryCAErrorParams(source ImageSource) map[string]any {
	params := map[string]any{"name": imageSourceIdentifier(source)}
	if path := strings.TrimSpace(source.RegistryCAPath); path != "" {
		params["path"] = path
	}
	return params
}

// loadRegistryCA 按路径优先读取 CA，并确认 PEM 里至少有一张证书。
// 保存时不读文件，所以失败只能发生在建链。
func loadRegistryCA(source ImageSource) ([]byte, *x509.CertPool, error) {
	var pemBytes []byte
	if path := strings.TrimSpace(source.RegistryCAPath); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, userErrorParamsCause("errors.image.registryCAReadFailed", registryCAErrorParams(source), err)
		}
		pemBytes = data
	} else {
		pemBytes = []byte(source.RegistryCAPEM)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, nil, userErrorParams("errors.image.registryCAParseFailed", registryCAErrorParams(source))
	}
	return pemBytes, pool, nil
}

type registryTransportCacheKey struct {
	base string
	mode string
	ca   string
}

type registryErrorTransport struct {
	err error
}

func (t registryErrorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	if t.err == nil {
		return nil, userError("errors.image.registryUnreachable")
	}
	return nil, t.err
}

// registryRoundTripper 按传输模式准备连接用的 RoundTripper。
// 标准 TLS 和明文沿用 base，不改它的 TLS 配置；需要改配置时先 clone，避免动到共享实例。
func (s *ImageService) registryRoundTripper(source ImageSource) (http.RoundTripper, error) {
	mode, ok := registryTransportMode(source.RegistryTransport)
	if !ok {
		return nil, userError("errors.config.registryTransportInvalid")
	}
	base := http.RoundTripper(remote.DefaultTransport)
	if s != nil && s.registryTransport != nil {
		base = s.registryTransport
	}
	var transport http.RoundTripper
	var err error
	if mode == registryTransportTLS || mode == registryTransportPlaintext {
		transport = base
	} else {
		var pemBytes []byte
		var pool *x509.CertPool
		if mode == registryTransportTLSCustomCA {
			loaded, certs, loadErr := loadRegistryCA(source)
			if loadErr != nil {
				return nil, loadErr
			}
			pemBytes, pool = loaded, certs
		}
		transport, err = s.cachedRegistryTransport(base, mode, pemBytes, pool)
		if err != nil {
			return nil, err
		}
	}
	scheme := "https"
	if mode == registryTransportPlaintext {
		scheme = "http"
	}
	// name.Registry 对回环和私网地址固定返回 http。按模式强制 scheme，
	// 避免内网 https 被库降级成明文，也避免明文来源误走 TLS。
	return schemeEnforcingTransport{base: transport, scheme: scheme}, nil
}

type schemeEnforcingTransport struct {
	base   http.RoundTripper
	scheme string
}

func (t schemeEnforcingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.base == nil {
		return nil, userError("errors.image.registryUnreachable")
	}
	if request.URL == nil || request.URL.Scheme == t.scheme {
		return t.base.RoundTrip(request)
	}
	rewritten := request.Clone(request.Context())
	rewritten.URL.Scheme = t.scheme
	return t.base.RoundTrip(rewritten)
}

func (s *ImageService) cachedRegistryTransport(base http.RoundTripper, mode string, pemBytes []byte, pool *x509.CertPool) (http.RoundTripper, error) {
	sum := sha256.Sum256(pemBytes)
	key := registryTransportCacheKey{
		base: fmt.Sprintf("%p", base),
		mode: mode,
		ca:   hex.EncodeToString(sum[:]),
	}
	if s == nil {
		return configureRegistryTransport(base, mode, pool)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.registryTLSCache == nil {
		s.registryTLSCache = map[registryTransportCacheKey]*http.Transport{}
	}
	if cached := s.registryTLSCache[key]; cached != nil {
		return cached, nil
	}
	configured, err := configureRegistryTransport(base, mode, pool)
	if err != nil {
		return nil, err
	}
	if transport, ok := configured.(*http.Transport); ok {
		s.registryTLSCache[key] = transport
	}
	return configured, nil
}

// configureRegistryTransport clone *http.Transport 后再写 TLSClientConfig。
// base 不是 *http.Transport 时退回 DefaultTransport 的 clone；两边都不是才原样返回。
func configureRegistryTransport(base http.RoundTripper, mode string, pool *x509.CertPool) (http.RoundTripper, error) {
	transport, ok := base.(*http.Transport)
	if !ok {
		transport, ok = remote.DefaultTransport.(*http.Transport)
	}
	if !ok || transport == nil {
		return base, nil
	}
	cloned := transport.Clone()
	tlsConfig := cloned.TLSClientConfig
	if tlsConfig == nil {
		tlsConfig = &tls.Config{}
	}
	switch mode {
	case registryTransportTLSSkipVerify:
		tlsConfig.InsecureSkipVerify = true
	case registryTransportTLSCustomCA:
		tlsConfig.RootCAs = pool
		tlsConfig.InsecureSkipVerify = false
	}
	cloned.TLSClientConfig = tlsConfig
	return cloned, nil
}

func registryEndpointOptions(source ImageSource) []name.Option {
	mode, ok := registryTransportMode(source.RegistryTransport)
	if ok && mode == registryTransportPlaintext {
		return []name.Option{name.Insecure}
	}
	return nil
}
