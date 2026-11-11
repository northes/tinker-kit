cask "tinker-kit" do
  version "0.20.0"
  sha256 "00e8371d4f57a22a19d74d2428c7307118b3a45af8c5da348e8d50a15e9efe49"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
