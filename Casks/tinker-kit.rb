cask "tinker-kit" do
  version "0.16.1"
  sha256 "375ad8188f4750aa7e596713bbc55c17d0d1cc915d6cd32eaf7434a25d7f4447"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
