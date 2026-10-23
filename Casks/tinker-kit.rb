cask "tinker-kit" do
  version "0.17.0"
  sha256 "f3df2151c314c48b914b0d1e1051395e18025936d8d11d3da6a06f4b99ed0fc3"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
