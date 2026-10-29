cask "tinker-kit" do
  version "0.18.1"
  sha256 "69e1b0cb1c03852e36660b5bc8ccfbb6542e4884bef2c47442637f8b047b5573"

  url "https://github.com/northes/tinker-kit/releases/download/v#{version}/TinkerKit-#{version}-darwin-universal.dmg"
  name "TinkerKit"
  desc "Desktop developer toolbox"
  homepage "https://github.com/northes/tinker-kit"

  auto_updates true
  depends_on macos: ">= :monterey"

  app "TinkerKit.app"
end
