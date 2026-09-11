#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
logo_svg="$script_dir/tinkerkit-logo.svg"
tray_svg="$script_dir/brackets-curly-duotone-white.svg"

for command in rsvg-convert wails3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "缺少命令: $command" >&2
    exit 1
  fi
done

cp "$logo_svg" "$root_dir/build/appicon.icon/Assets/wails_icon_vector.svg"
rsvg-convert -w 1024 -h 1024 "$logo_svg" -o "$root_dir/build/appicon.png"
rsvg-convert -w 128 -h 128 "$tray_svg" -o "$root_dir/assets/tray/tray-light.png"
rsvg-convert -w 128 -h 128 "$tray_svg" -o "$root_dir/assets/tray/tray-mac-template.png"

(
  cd "$root_dir/build"
  wails3 generate icons -input appicon.png -macfilename darwin/icons.icns -windowsfilename windows/icon.ico -iconcomposerinput appicon.icon -macassetdir darwin
)
echo "已更新托盘图标与各平台 App 图标；DMG 复用 macOS App 图标。"
