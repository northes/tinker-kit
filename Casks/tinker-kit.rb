cask "tinker-kit" do
  version "0.19.1"
  sha256 "25ab3d03bfee905a7cc329638ecf3f5b0e91ced04828cc82fab23ecbfed85a43"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
