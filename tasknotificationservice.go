package main

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// taskNotificationService 保留 Wails 通知服务的跨平台实现，同时将平台初始化失败
// 降级为“系统通知不可用”，避免影响应用启动。
type taskNotificationService struct {
	service *notifications.NotificationService
	mu      sync.RWMutex
	started bool
	err     error
}

func (s *taskNotificationService) ServiceName() string { return "TaskNotificationService" }

func (s *taskNotificationService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	err := s.service.ServiceStartup(ctx, options)
	s.mu.Lock()
	s.started, s.err = err == nil, err
	s.mu.Unlock()
	return nil
}

func (s *taskNotificationService) ServiceShutdown() error {
	s.mu.RLock()
	started := s.started
	s.mu.RUnlock()
	if !started {
		return nil
	}
	return s.service.ServiceShutdown()
}

func (s *taskNotificationService) IsAvailable() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.started
}

func (s *taskNotificationService) RequestAuthorization() (bool, error) {
	s.mu.RLock()
	started, err := s.started, s.err
	s.mu.RUnlock()
	if !started {
		if err != nil {
			return false, err
		}
		return false, userError("errors.common.notInitialized")
	}
	return s.service.RequestNotificationAuthorization()
}

func (s *taskNotificationService) Send(id, title, body string) error {
	s.mu.RLock()
	started, err := s.started, s.err
	s.mu.RUnlock()
	if !started {
		if err != nil {
			return err
		}
		return userError("errors.common.notInitialized")
	}
	return s.service.SendNotification(notifications.NotificationOptions{ID: id, Title: title, Body: body})
}

func (s *taskNotificationService) OpenNotificationSettings() error {
	for _, candidate := range notificationSettingsCommands(runtime.GOOS) {
		path, err := exec.LookPath(candidate[0])
		if err != nil {
			continue
		}
		command := exec.Command(path, candidate[1:]...)
		if err := command.Start(); err != nil {
			continue
		}
		return command.Process.Release()
	}
	return errors.New("notification settings launcher is unavailable")
}

func notificationSettingsCommands(goos string) [][]string {
	switch goos {
	case "darwin":
		return [][]string{{"open", "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.tinkerkit.app"}}
	case "windows":
		return [][]string{{"rundll32.exe", "url.dll,FileProtocolHandler", "ms-settings:privacy-notifications"}}
	case "linux":
		return [][]string{
			{"gnome-control-center", "notifications"},
			{"systemsettings", "kcm_notifications"},
			{"xfce4-notifyd-config"},
		}
	default:
		return nil
	}
}
