cask "tinker-kit" do
  version "0.18.2"
  sha256 "e6f9c0fff46a576327ad25aa62da295656834eba265a32b4c868dfc1f0749352"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
