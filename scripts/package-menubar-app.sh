#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_NAME="${APP_NAME:-CodexStatusMenu}"
SWIFT_SOURCE="${SCRIPT_DIR}/codex-status-menu.swift"
SWIFT_OUTPUT_DIR="${SCRIPT_DIR}/.build"
SWIFT_BINARY="${SWIFT_OUTPUT_DIR}/${APP_NAME}"
LEGACY_SWIFT_BINARY="${SWIFT_OUTPUT_DIR}/codex-status-menu"

APP_DIR="${ROOT_DIR}/dist/${APP_NAME}.app"
APP_MACOS_DIR="${APP_DIR}/Contents/MacOS"
APP_RESOURCES_DIR="${APP_DIR}/Contents/Resources"
RUNTIME_DIR="$HOME/Library/Application Support/weixue-codex-bridge/runtime"

NODE_MODULES_SRC="${ROOT_DIR}/node_modules"
NODE_MODULES_DST="${APP_RESOURCES_DIR}/node_modules"
NODE_MODULES_RUNTIME="${RUNTIME_DIR}/node_modules"

mkdir -p "${SWIFT_OUTPUT_DIR}" "${APP_MACOS_DIR}" "${APP_RESOURCES_DIR}" "${RUNTIME_DIR}/src"

swiftc -O -framework AppKit -framework Foundation "${SWIFT_SOURCE}" -o "${SWIFT_BINARY}"
cp "${SWIFT_BINARY}" "${APP_MACOS_DIR}/${APP_NAME}"
cp "${SWIFT_BINARY}" "${LEGACY_SWIFT_BINARY}"

cp "${SCRIPT_DIR}/codex-usage-bridge.js" "${APP_RESOURCES_DIR}/codex-usage-bridge.js"
cp "${SCRIPT_DIR}/codex-usage-bridge.js" "${RUNTIME_DIR}/codex-usage-bridge.js"
mkdir -p "${APP_RESOURCES_DIR}/src"
cp "${ROOT_DIR}/src/usage-format.js" "${APP_RESOURCES_DIR}/src/usage-format.js"
cp "${ROOT_DIR}/src/usage-format.js" "${RUNTIME_DIR}/src/usage-format.js"

if [[ -d "${NODE_MODULES_SRC}" ]]; then
  rm -rf "${NODE_MODULES_DST}"
  cp -R "${NODE_MODULES_SRC}" "${APP_RESOURCES_DIR}/"
  rm -rf "${NODE_MODULES_RUNTIME}"
  cp -R "${NODE_MODULES_SRC}" "${RUNTIME_DIR}/"
else
  echo "[warn] node_modules not found in repo root: ${NODE_MODULES_SRC}" >&2
fi

cat > "${APP_DIR}/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Codex 状态栏</string>
  <key>CFBundleExecutable</key>
  <string>CodexStatusMenu</string>
  <key>CFBundleIdentifier</key>
  <string>com.codex.weixue.statusmenu</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>CodexStatusMenu</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
EOF

printf 'APPL????' > "${APP_DIR}/Contents/PkgInfo"
chmod +x "${APP_MACOS_DIR}/${APP_NAME}"
codesign --force --sign - "${APP_DIR}"

echo "打包完成：${APP_DIR}"
