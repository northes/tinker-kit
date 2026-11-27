cask "tinker-kit" do
  version "0.25.2"
  sha256 "a826e98b4d7f46ae9837d8813b127311a5b844a88617442a07dc10102d6e17e3"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
