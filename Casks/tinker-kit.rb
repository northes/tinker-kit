cask "tinker-kit" do
  version "0.20.0"
  sha256 "1a08ef78b287dd4a9451822b87720e893e5e1168c0614af2eac8ea8621739c38"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
