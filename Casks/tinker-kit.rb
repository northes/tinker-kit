cask "tinker-kit" do
  version "0.23.0"
  sha256 "b4b95ef151c8667b162300ec1375993ab3b8ffb3eec7af7281a8e30bd0eeaf5b"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
