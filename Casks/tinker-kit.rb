cask "tinker-kit" do
  version "0.15.0"
  sha256 "ecb7bcb02b50760ace6c053f0dfe2d5048b6ab4d6755098f651e8c73ff5f3cb3"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
