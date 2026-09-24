#!/bin/sh
# TS-bindings freshness check: regenerate crates/protocol/bindings from the
# Rust types (ts_rs export tests) and fail if the committed copies differ.
set -e
cd "$(dirname "$0")/.."
cargo test -p protocol --features ts --quiet
# Uncommitted NEW files would not show in git diff — catch them too.
if ! git diff --exit-code -- crates/protocol/bindings >/dev/null || \
   [ -n "$(git status --porcelain -- crates/protocol/bindings)" ]; then
  echo "crates/protocol/bindings is stale or uncommitted — run scripts/check-bindings.sh and commit" >&2
  git --no-pager diff -- crates/protocol/bindings | head -40 >&2
  git status --porcelain -- crates/protocol/bindings >&2
  exit 1
fi
echo "bindings are fresh"
