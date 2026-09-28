package main

import (
	"errors"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/updater"
	githubprovider "github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

func TestMatchGitHubUpdateAssetSelectsDarwinUniversalZip(t *testing.T) {
	assets := []githubprovider.ReleaseAsset{
		{Name: "TinkerKit-0.2.0-darwin-universal.dmg"},
		{Name: "TinkerKit-0.2.0-darwin-arm64.zip"},
		{Name: "TinkerKit-0.2.0-darwin-universal.zip"},
	}
	got := matchGitHubUpdateAsset(updater.CheckRequest{Platform: "darwin", Arch: "arm64"}, assets)
	if got != 2 {
		t.Fatalf("期望选择 Universal ZIP（索引 2），实际为 %d", got)
	}
}

func TestMatchGitHubUpdateAssetRejectsInstallerOnlyRelease(t *testing.T) {
	assets := []githubprovider.ReleaseAsset{{Name: "TinkerKit-0.2.0-darwin-arm64.dmg"}}
	got := matchGitHubUpdateAsset(updater.CheckRequest{Platform: "darwin", Arch: "arm64"}, assets)
	if got != -1 {
		t.Fatalf("只有 DMG 时不应作为应用内更新包，实际为 %d", got)
	}
}

func TestMatchGitHubUpdateAssetSelectsDarwinUniversalZipWithoutArchitectureMatch(t *testing.T) {
	assets := []githubprovider.ReleaseAsset{
		{Name: "TinkerKit-0.2.0-darwin-universal.dmg"},
		{Name: "TinkerKit-0.2.0-darwin-universal.zip"},
	}
	got := matchGitHubUpdateAsset(updater.CheckRequest{Platform: "darwin", Arch: "arm64"}, assets)
	if got != 1 {
		t.Fatalf("缺少架构专用包时应选择 Universal ZIP（索引 1），实际为 %d", got)
	}
}

func TestMatchGitHubUpdateAssetDoesNotUseUniversalForOtherPlatforms(t *testing.T) {
	assets := []githubprovider.ReleaseAsset{{Name: "TinkerKit-0.2.0-linux-universal.zip"}}
	got := matchGitHubUpdateAsset(updater.CheckRequest{Platform: "linux", Arch: "arm64"}, assets)
	if got != -1 {
		t.Fatalf("非 macOS 平台不应回退到 Universal ZIP，实际为 %d", got)
	}
}

func TestUpdateErrorFromCheckClassifiesProviderFailures(t *testing.T) {
	svc := &UpdateService{}
	cases := []struct {
		name    string
		message string
		wantKey string
	}{
		{
			name:    "限流",
			message: `updater: all providers failed: github: api 403: {"message":"API rate limit exceeded for 155.254.126.241."}`,
			wantKey: "errors.update.rateLimited",
		},
		{
			name:    "网络故障",
			message: `updater: all providers failed: github: api request: Get "https://api.github.com/repos/northes/tinker-kit/releases/latest": dial tcp: lookup api.github.com: no such host`,
			wantKey: "errors.update.network",
		},
		{
			name:    "其它检查失败",
			message: "updater: all providers failed: github: release v9.9.9 has no asset for darwin/arm64",
			wantKey: "errors.update.checkFailed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := localizedErrorKey(svc.updateErrorFromCheck(errors.New(tc.message)))
			if got != tc.wantKey {
				t.Fatalf("期望 %q，实际为 %q", tc.wantKey, got)
			}
		})
	}
}

func TestUpdateErrorFromCheckRecordsRateLimitCooldown(t *testing.T) {
	svc := &UpdateService{}
	svc.updateErrorFromCheck(errors.New("github: api 429: too many requests"))
	if remaining := svc.rateLimitRemaining(); remaining <= 0 {
		t.Fatalf("识别到限流后应进入冷却窗口，实际 remaining=%v", remaining)
	}
}

func TestRateLimitedErrorCarriesRemainingMinutes(t *testing.T) {
	err := rateLimitedError(90 * time.Second)
	if got := localizedErrorKey(err); got != "errors.update.rateLimited" {
		t.Fatalf("期望 errors.update.rateLimited，实际为 %q", got)
	}
}
