package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
)

func TestRegistryEndpointUsesInsecureOnlyForPlaintext(t *testing.T) {
	plain, err := registryEndpoint(ImageSource{RegistryURL: "http://registry.example:5000", RegistryTransport: "plaintext"})
	if err != nil || plain.Scheme() != "http" {
		t.Fatalf("明文来源 scheme = %s，错误 %v", plain.Scheme(), err)
	}
	secure, err := registryEndpoint(ImageSource{RegistryURL: "https://registry.example", RegistryTransport: "tls"})
	if err != nil || secure.Scheme() != "https" {
		t.Fatalf("标准 TLS scheme = %s，错误 %v", secure.Scheme(), err)
	}
	if _, err := registryEndpoint(ImageSource{RegistryURL: "http://registry.example", RegistryTransport: "tls"}); localizedErrorKey(err) != "errors.config.registryURLSchemeMismatch" {
		t.Fatalf("模式与 scheme 不一致应拒绝，错误 %v", err)
	}
}

func TestRegistryPullSourceFallbackKeepsLibrarySchemeHandling(t *testing.T) {
	service := &ImageService{}
	target := ImageSource{Kind: "registry", RegistryURL: "https://other.example", RegistryTransport: "tlsCustomCA", RegistryCAPath: "/tmp/ca.pem"}
	publicRef, err := name.NewTag("registry.example/repo:latest")
	if err != nil {
		t.Fatalf("解析引用失败: %v", err)
	}
	fallback := service.registryPullSource(publicRef, target)
	if fallback.RegistryURL != "https://registry.example" || fallback.RegistryTransport != "tls" || !fallback.transportInferred {
		t.Fatalf("公网兜底来源为 %#v", fallback)
	}
	// 库把回环地址一律猜成 http，这不是用户声明的明文模式，不能据此强制明文。
	loopbackRef, err := name.NewTag("127.0.0.1:5000/repo:latest")
	if err != nil {
		t.Fatalf("解析回环引用失败: %v", err)
	}
	loopback := service.registryPullSource(loopbackRef, target)
	if loopback.RegistryURL != "https://127.0.0.1:5000" || loopback.RegistryTransport != "tls" || !loopback.transportInferred {
		t.Fatalf("回环兜底来源为 %#v", loopback)
	}
	matchedRef, err := name.NewTag("other.example/repo:latest")
	if err != nil {
		t.Fatalf("解析目标引用失败: %v", err)
	}
	matched := service.registryPullSource(matchedRef, target)
	if matched.RegistryTransport != "tlsCustomCA" || matched.RegistryCAPath != "/tmp/ca.pem" || matched.transportInferred {
		t.Fatalf("命中目标来源时应保留传输配置: %#v", matched)
	}
}

func TestRegistryInferredSourceSkipsSchemeEnforcement(t *testing.T) {
	base := &http.Transport{}
	service := &ImageService{registryTransport: base}
	ref, err := name.NewTag("127.0.0.1:5000/repo:latest")
	if err != nil {
		t.Fatalf("解析回环引用失败: %v", err)
	}
	inferred := service.registryPullSource(ref, ImageSource{Kind: "registry", RegistryURL: "https://other.example"})
	transport, err := service.registryRoundTripper(inferred)
	if err != nil {
		t.Fatalf("构建反推来源传输失败: %v", err)
	}
	if transport != http.RoundTripper(base) {
		t.Fatalf("反推来源不应强制 scheme，实际为 %#v", transport)
	}
	declared, err := service.registryRoundTripper(ImageSource{Kind: "registry", RegistryURL: "https://127.0.0.1:5000", RegistryTransport: "tls"})
	if err != nil {
		t.Fatalf("构建声明来源传输失败: %v", err)
	}
	if enforced, ok := declared.(schemeEnforcingTransport); !ok || enforced.scheme != "https" || enforced.base != http.RoundTripper(base) {
		t.Fatalf("声明来源应强制 https: %#v", declared)
	}
}

func TestRegistryTransportCloneDoesNotMutateBase(t *testing.T) {
	base := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "keep.example"}}
	service := &ImageService{registryTransport: base}
	source := ImageSource{Kind: "registry", Name: "仓库", RegistryURL: "https://registry.example", RegistryTransport: "tlsSkipVerify"}
	first, err := service.registryRoundTripper(source)
	if err != nil {
		t.Fatalf("构建跳过校验传输失败: %v", err)
	}
	enforced, ok := first.(schemeEnforcingTransport)
	cloned, _ := enforced.base.(*http.Transport)
	if !ok || enforced.scheme != "https" || cloned == nil || cloned == base || !cloned.TLSClientConfig.InsecureSkipVerify || cloned.TLSClientConfig.ServerName != "keep.example" {
		t.Fatalf("跳过校验传输应为 clone 且打开 InsecureSkipVerify: %#v", first)
	}
	if base.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("构建传输时就地改了共享 TLS 配置")
	}
	second, err := service.registryRoundTripper(source)
	if err != nil {
		t.Fatalf("再次构建跳过校验传输失败: %v", err)
	}
	if second.(schemeEnforcingTransport).base != enforced.base {
		t.Fatal("相同模式应复用缓存传输")
	}
	plain, err := service.registryRoundTripper(ImageSource{RegistryURL: "http://registry.example", RegistryTransport: "plaintext"})
	if err != nil {
		t.Fatalf("构建明文传输失败: %v", err)
	}
	plainEnforced, ok := plain.(schemeEnforcingTransport)
	if !ok || plainEnforced.scheme != "http" || plainEnforced.base != base {
		t.Fatalf("明文模式应沿用注入的 base，而不是 clone: %#v", plain)
	}
}

func TestRegistryCustomCAPathBeatsPEM(t *testing.T) {
	pathPEM := testRegistryCAPEM(t, "path-ca")
	pastePEM := testRegistryCAPEM(t, "paste-ca")
	dir := t.TempDir()
	path := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(path, []byte(pathPEM), 0o600); err != nil {
		t.Fatalf("写入 CA 失败: %v", err)
	}
	base := &http.Transport{}
	service := &ImageService{registryTransport: base}
	source := ImageSource{
		Kind: "registry", Name: "内网仓库", RegistryURL: "https://registry.example",
		RegistryTransport: "tlsCustomCA", RegistryCAPath: path, RegistryCAPEM: pastePEM,
	}
	transport, err := service.registryRoundTripper(source)
	if err != nil {
		t.Fatalf("自定义 CA 传输构建失败: %v", err)
	}
	enforced, ok := transport.(schemeEnforcingTransport)
	if !ok || enforced.scheme != "https" {
		t.Fatalf("自定义 CA 应强制 https: %#v", transport)
	}
	cloned := enforced.base.(*http.Transport)
	if cloned.TLSClientConfig.InsecureSkipVerify || !certPoolHasSubject(cloned.TLSClientConfig.RootCAs, "path-ca") || certPoolHasSubject(cloned.TLSClientConfig.RootCAs, "paste-ca") {
		t.Fatal("路径与 PEM 同时存在时应只用路径里的证书，并继续校验主机名")
	}
	missing := source
	missing.RegistryCAPath = filepath.Join(dir, "missing.pem")
	if _, err := service.registryRoundTripper(missing); localizedErrorKey(err) != "errors.image.registryCAReadFailed" || !stringsContainsAll(err.Error(), "内网仓库", missing.RegistryCAPath) {
		t.Fatalf("CA 文件读失败应定位来源，错误 %v", err)
	}
	invalid := source
	invalid.RegistryCAPath = ""
	invalid.RegistryCAPEM = "not a certificate"
	if _, err := service.registryRoundTripper(invalid); localizedErrorKey(err) != "errors.image.registryCAParseFailed" || !stringsContainsAll(err.Error(), "内网仓库") {
		t.Fatalf("无法解析的 PEM 应定位来源，错误 %v", err)
	}
}

func TestImageSourceFingerprintIncludesTransportWithoutReadingCA(t *testing.T) {
	base := ImageSource{Kind: "registry", RegistryURL: "https://registry.example"}
	if imageSourceFingerprint(base, "") != imageSourceFingerprint(ImageSource{Kind: "registry", RegistryURL: "https://registry.example", RegistryTransport: "tls"}, "") {
		t.Fatal("空传输模式应与 tls 使用同一指纹")
	}
	withCA := base
	withCA.RegistryTransport = "tlsCustomCA"
	withCA.RegistryCAPath = filepath.Join(t.TempDir(), "missing.pem")
	withCA.RegistryCAPEM = "pem"
	if imageSourceFingerprint(base, "") == imageSourceFingerprint(withCA, "") {
		t.Fatal("CA 配置变化后指纹不应保持不变")
	}
}

func testRegistryCAPEM(t *testing.T, commonName string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("生成证书失败: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func certPoolHasSubject(pool *x509.CertPool, commonName string) bool {
	if pool == nil {
		return false
	}
	needle := []byte(commonName)
	for _, subject := range pool.Subjects() {
		if bytes.Contains(subject, needle) {
			return true
		}
	}
	return false
}

func TestRegistryTransportErrorClassifiesCertificateFailures(t *testing.T) {
	source := ImageSource{RegistryURL: "https://registry.example", RegistryPassword: "secret-password"}
	hostname := x509.HostnameError{Certificate: &x509.Certificate{}, Host: "registry.example"}
	cases := []struct {
		name     string
		err      error
		fallback string
		want     string
	}{
		{
			name:     "未知 CA",
			err:      &url.Error{Op: "Get", URL: "https://registry.example/v2/", Err: &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}},
			fallback: "errors.image.registryUnreachable",
			want:     registryCertificateVerificationFailedKey,
		},
		{
			name:     "主机名不匹配",
			err:      hostname,
			fallback: "errors.imageExport.registryTransferFailed",
			want:     registryCertificateVerificationFailedKey,
		},
		{
			name:     "证书无效",
			err:      x509.CertificateInvalidError{Reason: x509.Expired, Detail: "expired"},
			fallback: "errors.image.registryUnreachable",
			want:     registryCertificateVerificationFailedKey,
		},
		{
			name:     "证书错误仍脱敏",
			err:      fmt.Errorf("auth secret-password: %w", x509.UnknownAuthorityError{}),
			fallback: "errors.imageExport.registryTransferFailed",
			want:     registryCertificateVerificationFailedKey,
		},
		{
			name:     "连接被拒绝",
			err:      &url.Error{Err: &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}},
			fallback: "errors.image.registryUnreachable",
			want:     "errors.image.registryUnreachable",
		},
		{
			name:     "超时",
			err:      &url.Error{Err: context.DeadlineExceeded},
			fallback: "errors.image.registryUnreachable",
			want:     "errors.image.registryUnreachable",
		},
		{
			name:     "DNS 失败",
			err:      &url.Error{Err: &net.DNSError{Err: "no such host", Name: "registry.example", IsNotFound: true}},
			fallback: "errors.imageExport.registryTransferFailed",
			want:     "errors.imageExport.registryTransferFailed",
		},
		{
			name:     "只有文本不算证书错误",
			err:      errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority"),
			fallback: "errors.image.registryUnreachable",
			want:     "errors.image.registryUnreachable",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := registryTransportError(tc.err, tc.fallback, source)
			if localizedErrorKey(err) != tc.want {
				t.Fatalf("key = %s，错误 %v", localizedErrorKey(err), err)
			}
			if strings.Contains(err.Error(), "secret-password") {
				t.Fatalf("凭据泄露在错误里: %v", err)
			}
		})
	}
}

func TestPingAndPullShareCertificateVerificationFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	source := ImageSource{Kind: "registry", Name: "本地", RegistryURL: server.URL, RegistryTransport: "tls"}
	pingErr := (&ImageService{}).pingRegistry(context.Background(), source)
	if localizedErrorKey(pingErr) != registryCertificateVerificationFailedKey {
		t.Fatalf("探活 = %v", pingErr)
	}
	if !strings.Contains(pingErr.Error(), "x509:") {
		t.Fatalf("证书细节应留在探活错误里: %v", pingErr)
	}

	transport, err := (&ImageService{}).registryRoundTripper(source)
	if err != nil {
		t.Fatalf("构建传输失败: %v", err)
	}
	request, err := http.NewRequest(http.MethodGet, server.URL+"/v2/repo/manifests/latest", nil)
	if err != nil {
		t.Fatalf("创建拉取请求失败: %v", err)
	}
	_, pullErr := transport.RoundTrip(request)
	if !isRegistryCertificateVerificationFailure(pullErr) {
		t.Fatalf("拉取错误链应是证书校验失败: %v", pullErr)
	}
	classified := registryTransportError(pullErr, "errors.imageExport.registryTransferFailed", source)
	if localizedErrorKey(classified) != registryCertificateVerificationFailedKey {
		t.Fatalf("拉取 = %v", classified)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	address := listener.Addr().String()
	listener.Close()
	refused := (&ImageService{}).pingRegistry(context.Background(), ImageSource{
		Kind: "registry", RegistryURL: "https://" + address, RegistryTransport: "tls",
	})
	if localizedErrorKey(refused) != "errors.image.registryUnreachable" {
		t.Fatalf("连接被拒绝应仍是不可达: %v", refused)
	}
}

func stringsContainsAll(value string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(value, part) {
			return false
		}
	}
	return true
}
