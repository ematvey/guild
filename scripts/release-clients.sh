#!/usr/bin/env bash
# Builds the Guild client distribution — GUI + engine in ONE archive per OS —
# and publishes it to a running guild-server.
#
#   linux-x86_64    native GUI build (webkit2gtk-4.1) + engine  -> tar.gz
#   darwin-aarch64  cargo-zigbuild + hand-assembled .app        -> tar.gz
#   darwin-x86_64   cargo-zigbuild + hand-assembled .app        -> tar.gz
#   windows-x86_64  cargo-zigbuild                              -> zip
#
# Each archive contains the GUI binary and the guild-app-server engine next
# to it (the GUI auto-detects a sibling engine), plus a README.
#
# Notes:
#   - macOS bundles are unsigned (Gatekeeper: right-click -> Open on first
#     run). Signing/notarization needs a Mac + Apple Developer cert.
#   - Windows GUI needs WebView2 (preinstalled on Win10/11).
#
# Usage:
#   BASE=http://localhost:18080 TOKEN=<admin-token> VERSION=0.1.0 \
#     scripts/release-clients.sh
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
TOKEN="${TOKEN:?set TOKEN to an admin session token}"
VERSION="${VERSION:?set VERSION, e.g. 0.1.0}"
export SDKROOT="${SDKROOT:-$HOME/macos-sdks/MacOSX11.3.sdk}"

cd "$(dirname "$0")/.."

echo "==> building GUI + engine"
cargo build --release -p guild-app-server >/dev/null                                  # linux engine
cargo build --release -p guild-desktop >/dev/null                                     # linux GUI
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-app-server --target aarch64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-app-server --target x86_64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-desktop --target aarch64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-desktop --target x86_64-apple-darwin >/dev/null
rustup target add x86_64-pc-windows-gnu >/dev/null
cargo zigbuild --release -p guild-app-server --target x86_64-pc-windows-gnu >/dev/null
cargo zigbuild --release -p guild-desktop --target x86_64-pc-windows-gnu >/dev/null

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

publish() { # platform src filename
  local platform="$1" src="$2" filename="$3"
  # idempotent: remove every existing artifact for this version+platform
  for old in $(curl -sf "$BASE/api/v1/releases" -H "authorization: Bearer $TOKEN" \
    | jq -r --arg p "$platform" '.releases[] | select(.version == "'"$VERSION"'" and .platform == $p) | .id'); do
    curl -sf -X DELETE "$BASE/api/v1/admin/releases/$old" -H "authorization: Bearer $TOKEN" >/dev/null
    echo "    replaced existing $platform artifact"
  done
  local local_sha remote_sha ctype="application/gzip"
  if [[ "$filename" == *.zip ]]; then ctype="application/zip"; fi
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

# ---- linux-x86_64 ----
LINUX="$STAGE/guild-$VERSION-linux-x86_64"
mkdir -p "$LINUX"
cp target/release/guild-desktop "$LINUX/guild-desktop"
cp target/release/guild-app-server "$LINUX/guild-app-server"
cp apps/desktop/src-tauri/icons/128x128.png "$LINUX/guild.png"
cat > "$LINUX/README.txt" <<'EOF'
Guild client — Linux (GUI + engine, portable).

  ./guild-desktop        GUI app (auto-spawns ./guild-app-server)
  ./guild-app-server     engine, also usable headless:
                           ./guild-app-server login --url http://<server> --email ... --password ...
                           ./guild-app-server chat --model <model> "hello"

Needs a running guild-server; enter its URL at login.
EOF
tar -C "$STAGE" -czf "$STAGE/guild-$VERSION-linux-x86_64.tar.gz" "$(basename "$LINUX")"
publish linux-x86_64 "$STAGE/guild-$VERSION-linux-x86_64.tar.gz" "guild-$VERSION-linux-x86_64.tar.gz"

# ---- macos: single .app containing both binaries ----
macos_readme() {
  cat > "$1/README.txt" <<'EOF'
Guild client — macOS (unsigned build).

1. Untar, then move Guild.app into /Applications.
2. First launch: right-click -> Open (unsigned; Gatekeeper will warn).
3. The engine (guild-app-server) ships inside the .app next to the GUI.
   Headless use: Guild.app/Contents/MacOS/guild-app-server login --url ...

Needs a running guild-server; enter its URL at login.
EOF
}
for pair in "aarch64 target/aarch64-apple-darwin" "x86_64 target/x86_64-apple-darwin"; do
  arch="${pair%% *}"; dir="${pair#* }"
  APPROOT="$STAGE/Guild-$VERSION-macos-$arch"
  mkdir -p "$APPROOT/Guild.app/Contents/MacOS" "$APPROOT/Guild.app/Contents/Resources"
  cp "$dir/release/guild-desktop" "$APPROOT/Guild.app/Contents/MacOS/Guild"
  cp "$dir/release/guild-app-server" "$APPROOT/Guild.app/Contents/MacOS/guild-app-server"
  cp apps/desktop/src-tauri/icons/icon.icns "$APPROOT/Guild.app/Contents/Resources/icon.icns"
  cat > "$APPROOT/Guild.app/Contents/Info.plist" <<EOF
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
  macos_readme "$APPROOT"
  tar -C "$STAGE" -czf "$STAGE/guild-$VERSION-macos-$arch.tar.gz" "Guild-$VERSION-macos-$arch"
  publish "darwin-$arch" "$STAGE/guild-$VERSION-macos-$arch.tar.gz" "guild-$VERSION-macos-$arch.tar.gz"
done

# ---- windows-x86_64 ----
WIN="$STAGE/guild-$VERSION-windows-x86_64"
mkdir -p "$WIN"
cp target/x86_64-pc-windows-gnu/release/guild-desktop.exe "$WIN/Guild.exe"
cp target/x86_64-pc-windows-gnu/release/guild-app-server.exe "$WIN/guild-app-server.exe"
cat > "$WIN/README.txt" <<'EOF'
Guild client — Windows (portable: GUI + engine).

  Guild.exe              GUI app (auto-spawns .\guild-app-server.exe)
  guild-app-server.exe   engine, also usable headless

Requires the WebView2 runtime (preinstalled on Windows 10/11).
Needs a running guild-server; enter its URL at login.
EOF
(cd "$STAGE" && zip -q -r "guild-$VERSION-windows-x86_64.zip" "$(basename "$WIN")")
publish windows-x86_64 "$STAGE/guild-$VERSION-windows-x86_64.zip" "guild-$VERSION-windows-x86_64.zip"

echo "==> client distributions published (GUI + engine, one per OS)"
