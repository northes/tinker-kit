cask "tinker-kit" do
  version "0.21.2"
  sha256 "417f55a77e632224cbcd5e6fd098f1a965d59be2e37f309f56bc9a9a1a70695b"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
