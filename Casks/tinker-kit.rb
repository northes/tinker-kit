cask "tinker-kit" do
  version "0.19.0"
  sha256 "bba5226b5c6ae8712cc54260cf925c0b7f4f4f2c48ede74e3408d0e05fe88515"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
