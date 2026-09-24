#!/bin/sh
# Windows compile gate for the engine (the desktop app's sidecar): cfg(unix)
# helpers called from ungated code only break on this target.
# Needs: rustup target add x86_64-pc-windows-gnu
set -e
cd "$(dirname "$0")/.."
cargo check -p guild-app-server --target x86_64-pc-windows-gnu --lib
