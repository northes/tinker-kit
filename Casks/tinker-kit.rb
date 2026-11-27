cask "tinker-kit" do
  version "0.26.0"
  sha256 "dd11cbbfecd6e277c635f58f772c1e049768bb96ec8231f841746777042c75e3"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
