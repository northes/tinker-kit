package main

import (
	"testing"

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
