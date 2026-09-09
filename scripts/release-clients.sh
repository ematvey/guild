#!/usr/bin/env bash
# Builds the guild-app-server CLI for every supported platform and publishes
# each artifact to a running guild-server's /api/v1/admin/releases.
#
# Requirements on the build host:
#   rustup targets: see `rustup target add` lines below
#   cargo-zigbuild + zig        (macOS + linux cross builds)
#   mingw-w64-gcc               (windows-gnu build)
#   SDKROOT at a macOS SDK      (e.g. ~/macos-sdks/MacOSX11.3.sdk)
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

rustup target add aarch64-unknown-linux-gnu x86_64-pc-windows-gnu \
  aarch64-apple-darwin x86_64-apple-darwin >/dev/null

echo "==> building guild-app-server for 5 platforms"
cargo zigbuild --release -p guild-app-server --target x86_64-unknown-linux-gnu.2.17 >/dev/null
cargo zigbuild --release -p guild-app-server --target aarch64-unknown-linux-gnu >/dev/null
cargo zigbuild --release -p guild-app-server --target x86_64-apple-darwin >/dev/null
cargo zigbuild --release -p guild-app-server --target aarch64-apple-darwin >/dev/null
cargo build --release -p guild-app-server --target x86_64-pc-windows-gnu >/dev/null

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

publish() { # platform path filename
  local platform="$1" binpath="$2" filename="$3"
  # idempotent: remove any existing artifact for this version/kind/platform
  local existing_id
  existing_id=$(curl -sf "$BASE/api/v1/releases" -H "authorization: Bearer $TOKEN" \
    | jq -r --arg p "$platform" '[.releases[] | select(.version == "'"$VERSION"'" and .kind == "cli" and .platform == $p)][0].id // empty')
  if [[ -n "$existing_id" ]]; then
    curl -sf -X DELETE "$BASE/api/v1/admin/releases/$existing_id" -H "authorization: Bearer $TOKEN" >/dev/null
    echo "    replaced existing $platform artifact"
  fi
  local archive
  if [[ "$filename" == *.zip ]]; then
    (cd "$(dirname "$binpath")" && zip -q -j "$STAGE/$filename" "$(basename "$binpath")")
    archive="$STAGE/$filename"
    ctype="application/zip"
  else
    tar -C "$(dirname "$binpath")" -czf "$STAGE/$filename" "$(basename "$binpath")"
    archive="$STAGE/$filename"
    ctype="application/gzip"
  fi
  local local_sha remote_sha
  local_sha=$(sha256sum "$archive" | cut -d' ' -f1)
  echo "==> $platform: $(basename "$filename") ($(stat -c%s "$archive") bytes)"
  remote_sha=$(curl -sf -X POST \
    "$BASE/api/v1/admin/releases?version=$VERSION&kind=cli&platform=$platform&filename=$filename&content_type=$ctype" \
    -H "authorization: Bearer $TOKEN" \
    -H "content-type: $ctype" \
    --data-binary @"$archive" | jq -r '.sha256')
  if [[ "$local_sha" != "$remote_sha" ]]; then
    echo "ERROR: server sha256 mismatch for $platform" >&2
    exit 1
  fi
  echo "    published, sha256 verified: ${remote_sha:0:16}…"
}

publish linux-x86_64  target/x86_64-unknown-linux-gnu/release/guild-app-server          "guild-cli-$VERSION-linux-x86_64.tar.gz"
publish linux-aarch64 target/aarch64-unknown-linux-gnu/release/guild-app-server          "guild-cli-$VERSION-linux-aarch64.tar.gz"
publish darwin-x86_64 target/x86_64-apple-darwin/release/guild-app-server                "guild-cli-$VERSION-macos-x86_64.tar.gz"
publish darwin-aarch64 target/aarch64-apple-darwin/release/guild-app-server              "guild-cli-$VERSION-macos-aarch64.tar.gz"
publish windows-x86_64 target/x86_64-pc-windows-gnu/release/guild-app-server.exe         "guild-cli-$VERSION-windows-x86_64.zip"

echo "==> all artifacts published and checksum-verified"
