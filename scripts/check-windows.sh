#!/bin/sh
# Windows compile gate for the engine (the desktop app's sidecar): cfg(unix)
# helpers called from ungated code only break on this target.
# Exit 2 means SKIP: the target is not installed on this host.
set -e
cd "$(dirname "$0")/.."
TARGET=x86_64-pc-windows-gnu
if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  echo "SKIP: rustup target $TARGET is not installed"
  echo "      install it with: rustup target add $TARGET"
  exit 2
fi
cargo check -p guild-app-server --target "$TARGET" --lib
