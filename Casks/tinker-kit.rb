cask "tinker-kit" do
  version "0.21.0"
  sha256 "5b5e6ea3d6aa250b02837a922a49627e742ba4f574cd2a66accf61deefb45238"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
