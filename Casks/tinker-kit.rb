cask "tinker-kit" do
  version "0.24.0"
  sha256 "7337bf7eae8037be1277009e1d2d62be2898af4ec8513e789c3fdd9fdf214a32"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
