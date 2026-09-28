package main

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

const (
	autoCheckInitialDelay = 30 * time.Second
	autoCheckInterval     = 24 * time.Hour
	// updateRateLimitCooldown 是识别到 GitHub 限流后暂停请求的时长，避免在
	// 配额耗尽时继续空转并消耗后续恢复的额度。
	updateRateLimitCooldown = 5 * time.Minute
)

type UpdateService struct {
	mu             sync.RWMutex
	checkMu        sync.Mutex
	updater        *updater.Updater
	currentVersion string
	autoEnabled    bool
	wake           chan struct{}
	stop           chan struct{}
	done           chan struct{}
	beforeRestart  func()
	stopOnce       sync.Once

	rateLimitedUntil time.Time
}

func (s *UpdateService) setBeforeRestart(before func()) {
	s.mu.Lock()
	s.beforeRestart = before
	s.mu.Unlock()
}

func NewUpdateService(version string) *UpdateService {
	return &UpdateService{currentVersion: version, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
}

func (s *UpdateService) ServiceName() string       { return "UpdateService" }
func (s *UpdateService) GetCurrentVersion() string { return s.currentVersion }

func (s *UpdateService) start(u *updater.Updater, enabled bool) {
	s.mu.Lock()
	s.updater = u
	s.autoEnabled = enabled
	s.mu.Unlock()
	go s.loop()
}

func (s *UpdateService) SetAutoCheckEnabled(enabled bool) {
	s.mu.Lock()
	changed := s.autoEnabled != enabled
	s.autoEnabled = enabled
	s.mu.Unlock()
	if changed {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

// CheckForUpdates runs a single check and reports whether a newer release is
// available. The result is also broadcast to the main window through the
// updater's own events (update-available / no-update), which drive the pill.
func (s *UpdateService) CheckForUpdates() (bool, error) {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	u := s.getUpdater()
	if u == nil {
		return false, userError("errors.update.notInitialized")
	}
	if remaining := s.rateLimitRemaining(); remaining > 0 {
		return false, rateLimitedError(remaining)
	}
	release, err := u.Check(context.Background())
	if err != nil {
		return false, s.updateErrorFromCheck(err)
	}
	return release != nil, nil
}

// InstallUpdate downloads, verifies and stages the pending release. If no
// release is pending it re-checks first. Download progress is reported via the
// updater's download-progress events, which the pill subscribes to.
func (s *UpdateService) InstallUpdate() error {
	u := s.getUpdater()
	if u == nil {
		return userError("errors.update.notInitialized")
	}
	if u.State() != updater.StateAvailable {
		if remaining := s.rateLimitRemaining(); remaining > 0 {
			return rateLimitedError(remaining)
		}
		s.checkMu.Lock()
		release, err := u.Check(context.Background())
		s.checkMu.Unlock()
		if err != nil {
			return s.updateErrorFromCheck(err)
		}
		if release == nil {
			return userError("errors.update.noUpdate")
		}
	}
	return u.DownloadAndInstall(context.Background())
}

// RestartApp applies the staged update and restarts into the new version.
func (s *UpdateService) RestartApp() error {
	u := s.getUpdater()
	if u == nil {
		return userError("errors.update.notInitialized")
	}
	s.mu.RLock()
	before := s.beforeRestart
	s.mu.RUnlock()
	if before != nil {
		before()
	}
	return u.Restart(context.Background())
}

func (s *UpdateService) stopScheduler() {
	s.stopOnce.Do(func() { close(s.stop) })
	<-s.done
}

func (s *UpdateService) loop() {
	defer close(s.done)
	timer := time.NewTimer(s.nextDelay())
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			if s.isAutoEnabled() {
				s.checkAutomatically()
			}
			timer.Reset(autoCheckInterval)
		case <-s.wake:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(s.nextDelay())
		case <-s.stop:
			return
		}
	}
}

func (s *UpdateService) nextDelay() time.Duration {
	if s.isAutoEnabled() {
		return autoCheckInitialDelay
	}
	return autoCheckInterval
}

// checkAutomatically polls the provider and lets the updater broadcast the
// result to the main window. Downloading is deferred until the user acts on
// the pill, so the update is announced without being installed unprompted.
func (s *UpdateService) checkAutomatically() {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	u := s.getUpdater()
	if u == nil {
		return
	}
	if _, err := u.Check(context.Background()); err != nil {
		if isRateLimitError(err) {
			s.markRateLimited()
		}
		log.Printf("自动检查更新失败: %v", err)
	}
}

func (s *UpdateService) getUpdater() *updater.Updater {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.updater
}

func (s *UpdateService) isAutoEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.autoEnabled
}

// --- 检查错误分类 ---

// updateErrorFromCheck 把一次 Check 的原始错误映射为前端可渲染的用户错误。
// updater 在聚合 provider 失败时会重建错误字符串并丢弃底层错误链（见 joinErrors），
// 因此这里只能依据错误文本区分限流、网络故障与其余检查失败；原始文本通过
// localizedError.Detail 原样透出，不参与翻译。识别到限流时记录冷却窗口。
func (s *UpdateService) updateErrorFromCheck(err error) error {
	switch {
	case isRateLimitError(err):
		s.markRateLimited()
		return rateLimitedError(updateRateLimitCooldown)
	case isNetworkError(err):
		return userErrorCause("errors.update.network", err)
	default:
		return userErrorCause("errors.update.checkFailed", err)
	}
}

func rateLimitedError(remaining time.Duration) error {
	minutes := int(remaining.Minutes())
	if minutes < 1 {
		minutes = 1
	}
	return userErrorParams("errors.update.rateLimited", map[string]any{"minutes": minutes})
}

func isRateLimitError(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "rate limit") ||
		strings.Contains(message, "api 403") ||
		strings.Contains(message, "api 429")
}

func isNetworkError(err error) bool {
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"api request",
		"dial tcp",
		"no such host",
		"connection refused",
		"connection reset",
		"i/o timeout",
		"tls handshake",
		"context deadline exceeded",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func (s *UpdateService) markRateLimited() {
	s.mu.Lock()
	s.rateLimitedUntil = time.Now().Add(updateRateLimitCooldown)
	s.mu.Unlock()
}

func (s *UpdateService) rateLimitRemaining() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return time.Until(s.rateLimitedUntil)
}
