package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strconv"
	"strings"
)

type systemProxyConfig struct {
	httpProxy         *url.URL
	httpsProxy        *url.URL
	socksProxy        *url.URL
	bypass            []string
	bypassSimpleHosts bool
	automaticProxy    string
	source            string
}

func (c systemProxyConfig) hasProxy() bool {
	return c.httpProxy != nil || c.httpsProxy != nil || c.socksProxy != nil
}

func (c systemProxyConfig) hasHTTPProxy() bool {
	return c.httpProxy != nil || c.httpsProxy != nil
}

func (r *networkRoute) resolveSystemProxy(target networkTarget) error {
	if r.proxyType != "system" {
		return nil
	}

	protocol := strings.ToLower(strings.TrimSpace(r.request.Protocol))
	r.run.stage("proxy-resolve", "running", NetworkTestStage{
		Request: "Resolve system proxy for " + net.JoinHostPort(target.Host, target.Port),
		Meta:    map[string]string{"protocol": protocol},
	})

	config, err := loadSystemProxyConfig(r.run.ctx)
	if err != nil {
		r.run.fail("proxy-resolve", err)
		return err
	}
	if config.automaticProxy != "" {
		err := fmt.Errorf("%s is configured, but automatic proxy scripts are not supported", config.automaticProxy)
		r.run.fail("proxy-resolve", err)
		return err
	}

	meta := map[string]string{"source": config.source}
	if config.isBypassed(target.Host, target.Port) {
		if strings.EqualFold(r.request.DNSMode, "proxy") {
			err := errors.New("proxy DNS resolution is unavailable because system proxy rules bypass this target")
			r.run.fail("proxy-resolve", err)
			return err
		}
		r.proxyType = ""
		r.proxyURL = nil
		meta["mode"] = "direct"
		meta["bypassed"] = "true"
		r.run.stage("proxy-resolve", "success", NetworkTestStage{Response: "Target is excluded by system proxy bypass rules; connecting directly", Meta: meta})
		return nil
	}

	proxyType, proxyURL, err := config.proxyFor(protocol, target)
	if err != nil {
		r.run.fail("proxy-resolve", err)
		return err
	}
	if strings.EqualFold(r.request.DNSMode, "proxy") && proxyType != "socks5" {
		err := errors.New("proxy DNS resolution requires the selected system proxy to be SOCKS5")
		r.run.fail("proxy-resolve", err)
		return err
	}
	r.proxyType = proxyType
	r.proxyURL = proxyURL
	if proxyURL == nil {
		meta["mode"] = "direct"
		response := "No system proxy is configured; connecting directly"
		if protocol == "udp" || protocol == "ntp" {
			if config.hasHTTPProxy() {
				err := errors.New("the system has only an HTTP proxy configured; UDP and NTP require a SOCKS5 proxy with UDP ASSOCIATE or a direct route")
				r.run.fail("proxy-resolve", err)
				return err
			}
		}
		r.run.stage("proxy-resolve", "success", NetworkTestStage{Response: response, Meta: meta})
		return nil
	}
	meta["mode"] = proxyType
	meta["proxy"] = proxyURL.String()
	r.run.stage("proxy-resolve", "success", NetworkTestStage{Response: "Using " + strings.ToUpper(proxyType) + " system proxy " + proxyURL.String(), Meta: meta})
	return nil
}

func (c systemProxyConfig) proxyFor(protocol string, target networkTarget) (string, *url.URL, error) {
	switch protocol {
	case "udp", "ntp":
		if c.socksProxy != nil {
			return "socks5", c.socksProxy, nil
		}
		if c.hasHTTPProxy() {
			return "", nil, errors.New("the system has only an HTTP proxy configured; UDP and NTP require a SOCKS5 proxy with UDP ASSOCIATE or a direct route")
		}
		return "", nil, nil
	case "tcp":
		if c.socksProxy != nil {
			return "socks5", c.socksProxy, nil
		}
		if c.httpsProxy != nil {
			return "http", c.httpsProxy, nil
		}
		if c.httpProxy != nil {
			return "http", c.httpProxy, nil
		}
		return "", nil, nil
	case "http", "websocket":
		scheme := "http"
		if target.URL != nil && (target.URL.Scheme == "https" || target.URL.Scheme == "wss") {
			scheme = "https"
		}
		if scheme == "https" && c.httpsProxy != nil {
			return "http", c.httpsProxy, nil
		}
		if scheme == "http" && c.httpProxy != nil {
			return "http", c.httpProxy, nil
		}
		if c.socksProxy != nil {
			return "socks5", c.socksProxy, nil
		}
		if c.httpsProxy != nil {
			return "http", c.httpsProxy, nil
		}
		if c.httpProxy != nil {
			return "http", c.httpProxy, nil
		}
		return "", nil, nil
	default:
		return "", nil, fmt.Errorf("system proxy is not supported for protocol %q", protocol)
	}
}

func (c systemProxyConfig) isBypassed(host, port string) bool {
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	if c.bypassSimpleHosts && !strings.Contains(host, ".") && net.ParseIP(host) == nil {
		return true
	}
	for _, item := range c.bypass {
		pattern := strings.TrimSpace(item)
		if pattern == "" {
			continue
		}
		if pattern == "*" {
			return true
		}
		if strings.EqualFold(pattern, "<local>") {
			if !strings.Contains(host, ".") {
				return true
			}
			continue
		}
		patternHost, patternPort := splitBypassPort(pattern)
		if patternPort != "" && patternPort != port {
			continue
		}
		if ip := net.ParseIP(host); ip != nil {
			if _, subnet, err := net.ParseCIDR(patternHost); err == nil && subnet.Contains(ip) {
				return true
			}
		}
		patternHost = strings.ToLower(patternHost)
		candidate := strings.ToLower(strings.TrimSuffix(host, "."))
		if strings.ContainsAny(patternHost, "*?") {
			if matched, _ := path.Match(patternHost, candidate); matched {
				return true
			}
			continue
		}
		subdomainsOnly := strings.HasPrefix(patternHost, ".")
		patternHost = strings.TrimPrefix(patternHost, ".")
		if patternHost == candidate || strings.HasSuffix(candidate, "."+patternHost) {
			if !subdomainsOnly || candidate != patternHost {
				return true
			}
		}
	}
	return false
}

func splitBypassPort(value string) (string, string) {
	if strings.HasPrefix(value, "[") {
		if host, port, err := net.SplitHostPort(value); err == nil {
			return host, port
		}
	}
	if strings.Count(value, ":") == 1 {
		host, port, _ := strings.Cut(value, ":")
		if _, err := strconv.Atoi(port); err == nil {
			return host, port
		}
	}
	return value, ""
}

func loadSystemProxyConfig(ctx context.Context) (systemProxyConfig, error) {
	envConfig, envErr := proxyConfigFromEnvironment()
	if envErr != nil {
		return systemProxyConfig{}, envErr
	}

	var native systemProxyConfig
	var found bool
	var err error
	switch runtime.GOOS {
	case "darwin":
		native, found, err = proxyConfigFromMacOS(ctx)
	case "windows":
		native, found, err = proxyConfigFromWindows(ctx)
	case "linux":
		native, found, err = proxyConfigFromGNOME(ctx)
	}
	if err != nil {
		return systemProxyConfig{}, err
	}
	if found && (native.hasProxy() || native.automaticProxy != "") {
		return native, nil
	}
	if envConfig.hasProxy() {
		return envConfig, nil
	}
	if found {
		return native, nil
	}
	return envConfig, nil
}

func proxyConfigFromEnvironment() (systemProxyConfig, error) {
	config := systemProxyConfig{source: "proxy environment variables"}
	var err error
	if value := firstEnv("http_proxy", "HTTP_PROXY"); value != "" {
		config.httpProxy, err = parseSystemProxyURL(value, "http")
		if err != nil {
			return systemProxyConfig{}, fmt.Errorf("read HTTP proxy environment variable: %w", err)
		}
	}
	if value := firstEnv("https_proxy", "HTTPS_PROXY"); value != "" {
		config.httpsProxy, err = parseSystemProxyURL(value, "http")
		if err != nil {
			return systemProxyConfig{}, fmt.Errorf("read HTTPS proxy environment variable: %w", err)
		}
	}
	if value := firstEnv("all_proxy", "ALL_PROXY"); value != "" {
		proxy, parseErr := parseSystemProxyURL(value, "http")
		if parseErr != nil {
			return systemProxyConfig{}, fmt.Errorf("read ALL_PROXY environment variable: %w", parseErr)
		}
		if proxy.Scheme == "socks5" {
			config.socksProxy = proxy
		} else {
			if config.httpProxy == nil {
				config.httpProxy = proxy
			}
			if config.httpsProxy == nil {
				config.httpsProxy = proxy
			}
		}
	}
	config.bypass = splitProxyBypass(firstEnv("no_proxy", "NO_PROXY"), ",")
	return config, nil
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func splitProxyBypass(value, separator string) []string {
	items := strings.Split(value, separator)
	result := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item != "" {
			result = append(result, item)
		}
	}
	return result
}

func parseSystemProxyURL(value, defaultScheme string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if !strings.Contains(value, "://") {
		value = defaultScheme + "://" + value
	}
	proxy, err := url.Parse(value)
	if err != nil || proxy.Hostname() == "" || proxy.RawQuery != "" || proxy.Fragment != "" {
		return nil, errors.New("proxy address is malformed")
	}
	if proxy.User != nil {
		return nil, errors.New("system proxy authentication is not supported")
	}
	if proxy.Scheme != "http" && proxy.Scheme != "socks5" {
		return nil, fmt.Errorf("system proxy scheme %q is unsupported; use HTTP or SOCKS5", proxy.Scheme)
	}
	port := proxy.Port()
	if port == "" {
		port = "80"
		if proxy.Scheme == "socks5" {
			port = "1080"
		}
		proxy.Host = net.JoinHostPort(proxy.Hostname(), port)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return nil, errors.New("proxy port must be between 1 and 65535")
	}
	return proxy, nil
}

func proxyFromHostPort(host string, port int, scheme string) (*url.URL, error) {
	host = strings.TrimSpace(host)
	if host == "" || port < 1 || port > 65535 {
		return nil, nil
	}
	return parseSystemProxyURL(net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port)), scheme)
}

func proxyConfigFromMacOS(ctx context.Context) (systemProxyConfig, bool, error) {
	output, err := exec.CommandContext(ctx, "/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("read macOS system proxy settings: %w", err)
	}
	config := systemProxyConfig{source: "macOS network settings"}
	values := make(map[string]string)
	inExceptions := false
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.Contains(line, "ExceptionsList : <array>") {
			inExceptions = true
			continue
		}
		if inExceptions && line == "}" {
			inExceptions = false
			continue
		}
		if inExceptions {
			_, item, ok := strings.Cut(line, ":")
			if ok {
				config.bypass = append(config.bypass, strings.TrimSpace(item))
			}
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	if err := scanner.Err(); err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("parse macOS system proxy settings: %w", err)
	}
	config.bypassSimpleHosts = values["ExcludeSimpleHostnames"] == "1"
	if values["ProxyAutoConfigEnable"] == "1" {
		config.automaticProxy = "macOS PAC proxy"
	} else if values["ProxyAutoDiscoveryEnable"] == "1" {
		config.automaticProxy = "macOS automatic proxy discovery (WPAD)"
	}
	if values["HTTPEnable"] == "1" {
		config.httpProxy, err = proxyFromHostPort(values["HTTPProxy"], parseInt(values["HTTPPort"]), "http")
		if err != nil {
			return systemProxyConfig{}, false, err
		}
	}
	if values["HTTPSEnable"] == "1" {
		config.httpsProxy, err = proxyFromHostPort(values["HTTPSProxy"], parseInt(values["HTTPSPort"]), "http")
		if err != nil {
			return systemProxyConfig{}, false, err
		}
	}
	if values["SOCKSEnable"] == "1" {
		config.socksProxy, err = proxyFromHostPort(values["SOCKSProxy"], parseInt(values["SOCKSPort"]), "socks5")
		if err != nil {
			return systemProxyConfig{}, false, err
		}
	}
	return config, true, nil
}

func proxyConfigFromWindows(ctx context.Context) (systemProxyConfig, bool, error) {
	output, err := exec.CommandContext(ctx, "reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`).Output()
	if err != nil {
		return systemProxyConfig{source: "Windows user proxy settings"}, false, nil
	}
	config := systemProxyConfig{source: "Windows user proxy settings"}
	values := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 3 {
			values[strings.ToLower(fields[0])] = strings.Join(fields[2:], " ")
		}
	}
	if err := scanner.Err(); err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("parse Windows system proxy settings: %w", err)
	}
	if autoConfig := strings.TrimSpace(values["autoconfigurl"]); autoConfig != "" {
		config.automaticProxy = "Windows automatic proxy configuration (PAC)"
	}
	if values["autodetect"] == "0x1" {
		config.automaticProxy = "Windows automatic proxy discovery (WPAD)"
	}
	if values["proxyenable"] == "0x1" {
		config.httpProxy, config.httpsProxy, config.socksProxy, err = parseWindowsProxyServer(values["proxyserver"])
		if err != nil {
			return systemProxyConfig{}, false, err
		}
		config.bypass = splitProxyBypass(values["proxyoverride"], ";")
	}
	return config, true, nil
}

func parseWindowsProxyServer(value string) (*url.URL, *url.URL, *url.URL, error) {
	var httpProxy, httpsProxy, socksProxy *url.URL
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil, nil, errors.New("Windows proxy is enabled but no proxy address is configured")
	}
	if !strings.Contains(value, "=") {
		proxy, err := parseSystemProxyURL(value, "http")
		if err != nil {
			return nil, nil, nil, err
		}
		return proxy, proxy, nil, nil
	}
	for _, entry := range strings.Split(value, ";") {
		name, address, ok := strings.Cut(strings.TrimSpace(entry), "=")
		if !ok {
			continue
		}
		proxy, err := parseSystemProxyURL(strings.TrimSpace(address), "http")
		if err != nil {
			return nil, nil, nil, err
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "http":
			httpProxy = proxy
		case "https":
			httpsProxy = proxy
		case "socks", "socks5":
			proxy.Scheme = "socks5"
			socksProxy = proxy
		}
	}
	return httpProxy, httpsProxy, socksProxy, nil
}

func proxyConfigFromGNOME(ctx context.Context) (systemProxyConfig, bool, error) {
	modeOutput, err := exec.CommandContext(ctx, "gsettings", "get", "org.gnome.system.proxy", "mode").Output()
	if err != nil {
		return systemProxyConfig{}, false, nil
	}
	mode := strings.Trim(strings.TrimSpace(string(modeOutput)), "'")
	config := systemProxyConfig{source: "GNOME session proxy settings"}
	switch mode {
	case "none":
		return config, true, nil
	case "auto":
		config.automaticProxy = "GNOME automatic proxy configuration (PAC)"
		return config, true, nil
	case "manual":
	default:
		return systemProxyConfig{}, false, fmt.Errorf("unsupported GNOME proxy mode %q", mode)
	}

	read := func(schema, key string) (string, error) {
		output, err := exec.CommandContext(ctx, "gsettings", "get", schema, key).Output()
		if err != nil {
			return "", err
		}
		return strings.Trim(strings.TrimSpace(string(output)), "'"), nil
	}
	readProxy := func(protocol string) (*url.URL, error) {
		host, err := read("org.gnome.system.proxy."+protocol, "host")
		if err != nil || host == "" {
			return nil, err
		}
		portValue, err := read("org.gnome.system.proxy."+protocol, "port")
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portValue)
		if err != nil {
			return nil, fmt.Errorf("parse GNOME %s proxy port: %w", protocol, err)
		}
		scheme := "http"
		if protocol == "socks" {
			scheme = "socks5"
		}
		return proxyFromHostPort(host, port, scheme)
	}

	config.httpProxy, err = readProxy("http")
	if err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("read GNOME HTTP proxy settings: %w", err)
	}
	useSameProxy, err := read("org.gnome.system.proxy", "use-same-proxy")
	if err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("read GNOME proxy mode: %w", err)
	}
	if useSameProxy == "true" {
		config.httpsProxy = config.httpProxy
	} else {
		config.httpsProxy, err = readProxy("https")
		if err != nil {
			return systemProxyConfig{}, false, fmt.Errorf("read GNOME HTTPS proxy settings: %w", err)
		}
	}
	config.socksProxy, err = readProxy("socks")
	if err != nil {
		return systemProxyConfig{}, false, fmt.Errorf("read GNOME SOCKS proxy settings: %w", err)
	}
	if bypass, err := read("org.gnome.system.proxy", "ignore-hosts"); err == nil {
		bypass = strings.TrimSpace(strings.Trim(bypass, "[]"))
		for _, item := range strings.Split(bypass, ",") {
			item = strings.Trim(strings.TrimSpace(item), "'")
			if item != "" {
				config.bypass = append(config.bypass, item)
			}
		}
	}
	return config, true, nil
}

func parseInt(value string) int {
	parsed, _ := strconv.Atoi(strings.TrimSpace(value))
	return parsed
}
