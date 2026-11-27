cask "tinker-kit" do
  version "0.25.1"
  sha256 "8badc48d7fdba46e1cc2eb6328b53df231c1b3c81984e18bc435fe1fcb139f1f"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
