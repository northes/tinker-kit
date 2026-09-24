package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
)

const (
	autoCheckInitialDelay = 30 * time.Second
	autoCheckInterval     = 24 * time.Hour
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
	release, err := u.Check(context.Background())
	if err != nil {
		return false, err
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
		s.checkMu.Lock()
		release, err := u.Check(context.Background())
		s.checkMu.Unlock()
		if err != nil {
			return err
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
