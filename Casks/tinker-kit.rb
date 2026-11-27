cask "tinker-kit" do
  version "0.25.0"
  sha256 "65f00da10e66c6f6e9317ee45f03384043b33a2f23ccb674cbc3e895ab4df276"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
