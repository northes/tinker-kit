cask "tinker-kit" do
  version "0.22.0"
  sha256 "338d47a431495cb682cd5d8f0a5802f1854ade9905c82a64cfe3a994c68c032c"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
