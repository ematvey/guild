#!/usr/bin/env bash
# Builds the Guild desktop app (Tauri) for all platforms this host can produce
# and publishes each artifact to a running guild server.
#
#   linux-x86_64    native build (webkit2gtk-4.1 required)      -> tar.gz (portable)
#   darwin-aarch64   cargo-zigbuild + manual .app assembly        -> tar.gz of .app
#   darwin-x86_64    cargo-zigbuild + manual .app assembly        -> tar.gz of .app
#   windows-x86_64  cargo-zigbuild                               -> zip (portable exe)
#
# Notes:
#   - macOS bundles are unsigned; Gatekeeper will ask on first run.
#     macOS .dmg/signing must happen on a Mac.
#   - Windows exe is portable; needs WebView2 (built into Win10/11).
#
# Usage:
#   BASE=http://localhost:18080 TOKEN=<admin-token> VERSION=0.1.0 \
#     scripts/release-desktop.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
TOKEN="${TOKEN:?set TOKEN to an admin session token}"
VERSION="${VERSION:?set VERSION, e.g. 0.1.0}"
export SDKROOT="${SDKROOT:-$HOME/macos-sdks/MacOSX11.3.sdk}"

cd "$(dirname "$0")/.."

echo "==> building Guild desktop for available targets"
# custom-protocol is REQUIRED: without it even a release build loads devUrl
# (http://localhost:1420) instead of the embedded dist — white screen.
cargo build --release -p guild-desktop --features tauri/custom-protocol >/dev/null  # linux-x86_64
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-desktop --target aarch64-apple-darwin --features tauri/custom-protocol >/dev/null
cargo zigbuild --release -p guild-desktop --target x86_64-apple-darwin --features tauri/custom-protocol >/dev/null
rustup target add x86_64-pc-windows-gnu >/dev/null
cargo zigbuild --release -p guild-desktop --target x86_64-pc-windows-gnu --features tauri/custom-protocol >/dev/null

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# idempotent publish: replace any existing artifact for version/kind/platform
publish() { # platform path filename
  local platform="$1" src="$2" filename="$3"
  local existing_id
  existing_id=$(curl -sf "$BASE/api/v1/releases" -H "authorization: Bearer $TOKEN" \
    | jq -r --arg p "$platform" '[.releases[] | select(.version == "'"$VERSION"'" and .kind == "desktop" and .platform == $p)][0].id // empty')
  if [[ -n "$existing_id" ]]; then
    curl -sf -X DELETE "$BASE/api/v1/admin/releases/$existing_id" -H "authorization: Bearer $TOKEN" >/dev/null
    echo "    replaced existing $platform desktop artifact"
  fi
  local local_sha remote_sha ctype="application/gzip"
  local_sha=$(sha256sum "$src" | cut -d' ' -f1)
  echo "==> $platform: $filename ($(stat -c%s "$src") bytes)"
  remote_sha=$(curl -sf -X POST \
    "$BASE/api/v1/admin/releases?version=$VERSION&kind=desktop&platform=$platform&filename=$filename&content_type=$ctype" \
    -H "authorization: Bearer $TOKEN" -H "content-type: $ctype" \
    --data-binary @"$src" | jq -r '.sha256')
  if [[ "$local_sha" != "$remote_sha" ]]; then
    echo "ERROR: server sha256 mismatch for $platform" >&2
    exit 1
  fi
  echo "    published, sha256 verified: ${remote_sha:0:16}…"
}

# ---- linux-x86_64: portable tar.gz (binary + launcher) ----
LINUX="$STAGE/guild-desktop-$VERSION-linux-x86_64"
mkdir -p "$LINUX"
cp target/release/guild-desktop "$LINUX/guild-desktop"
cp apps/desktop/src-tauri/icons/128x128.png "$LINUX/guild.png"
cat > "$LINUX/README.txt" <<'EOF'
Guild desktop (Linux, portable).
Run: ./guild-desktop   (needs a running guild server; enter its URL at login)
Optional desktop entry: Exec=<path>/guild-desktop, Icon=<path>/guild.png
EOF
tar -C "$STAGE" -czf "$STAGE/guild-desktop-$VERSION-linux-x86_64.tar.gz" "$(basename "$LINUX")"
publish linux-x86_64 "$STAGE/guild-desktop-$VERSION-linux-x86_64.tar.gz" "guild-desktop-$VERSION-linux-x86_64.tar.gz"

# ---- macos: .app bundles (unsigned) ----
make_macos_app() { # target_dir app_dir_name binpath
  local bindir="$1" app="$2" bin="$3"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$bindir/$bin" "$app/Contents/MacOS/Guild"
  cp apps/desktop/src-tauri/icons/icon.icns "$app/Contents/Resources/icon.icns"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Guild</string>
  <key>CFBundleDisplayName</key><string>Guild</string>
  <key>CFBundleIdentifier</key><string>org.guild.desktop</string>
  <key>CFBundleExecutable</key><string>Guild</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF
}

for pair in "aarch64 target/aarch64-apple-darwin/release/guild-desktop" \
            "x86_64 target/x86_64-apple-darwin/release/guild-desktop"; do
  arch="${pair%% *}"; binpath="${pair#* }"
  APPROOT="$STAGE/Guild-$VERSION-macos-$arch"
  make_macos_app "$(dirname "$binpath")" "$APPROOT/Guild.app" "$(basename "$binpath")"
  cat > "$APPROOT/README.txt" <<'EOF'
Guild desktop (macOS, unsigned build).
1. Untar, then move Guild.app into /Applications.
2. First launch: right-click -> Open (unsigned; Gatekeeper will warn).
3. Needs a running guild server; enter its URL at login.
EOF
  tar -C "$STAGE" -czf "$STAGE/guild-desktop-$VERSION-macos-$arch.tar.gz" "Guild-$VERSION-macos-$arch"
  publish "darwin-$arch" "$STAGE/guild-desktop-$VERSION-macos-$arch.tar.gz" "guild-desktop-$VERSION-macos-$arch.tar.gz"
done

# ---- windows-x86_64: portable zip ----
WIN="$STAGE/guild-desktop-$VERSION-windows-x86_64"
mkdir -p "$WIN"
cp target/x86_64-pc-windows-gnu/release/guild-desktop.exe "$WIN/Guild.exe"
cat > "$WIN/README.txt" <<'EOF'
Guild desktop (Windows, portable).
Run Guild.exe — requires the WebView2 runtime (preinstalled on Windows 10/11;
the installer downloads it automatically if missing: see
https://developer.microsoft.com/microsoft-edge/webview2/).
Needs a running guild server; enter its URL at login.
EOF
(cd "$STAGE" && zip -q -r "guild-desktop-$VERSION-windows-x86_64.zip" "$(basename "$WIN")")
publish windows-x86_64 "$STAGE/guild-desktop-$VERSION-windows-x86_64.zip" "guild-desktop-$VERSION-windows-x86_64.zip"

echo "==> desktop artifacts published"
