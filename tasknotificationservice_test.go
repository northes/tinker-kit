package main

import (
	"reflect"
	"testing"
)

func TestNotificationSettingsCommands(t *testing.T) {
	tests := []struct {
		goos string
		want [][]string
	}{
		{
			goos: "darwin",
			want: [][]string{{"open", "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.tinkerkit.app"}},
		},
		{
			goos: "windows",
			want: [][]string{{"rundll32.exe", "url.dll,FileProtocolHandler", "ms-settings:privacy-notifications"}},
		},
		{
			goos: "linux",
			want: [][]string{
				{"gnome-control-center", "notifications"},
				{"systemsettings", "kcm_notifications"},
				{"xfce4-notifyd-config"},
			},
		},
		{goos: "plan9", want: nil},
	}

	for _, test := range tests {
		t.Run(test.goos, func(t *testing.T) {
			if got := notificationSettingsCommands(test.goos); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("notificationSettingsCommands(%q) = %#v, want %#v", test.goos, got, test.want)
			}
		})
	}
}
