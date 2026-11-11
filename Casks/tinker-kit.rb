cask "tinker-kit" do
  version "0.21.1"
  sha256 "511e63bef1664a50aa261209f001ac4bf13e9482b7f137b3f18b6d4e02debdad"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
