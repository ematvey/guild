#!/usr/bin/env bash
# Set the product version everywhere it lives, in one step. The list of
# files is the contract — see docs/deploy-nuances.md §10 for the why and
# the per-file details.
#
# Usage: scripts/bump-version.sh <semver>   e.g. scripts/bump-version.sh 0.5.38
set -euo pipefail

BUILD=0
SYNC=0
if [[ "${1:-}" == "--build" ]]; then BUILD=1; shift; fi
if [[ "${1:-}" == "--sync" ]]; then SYNC=1; shift; fi
V="${1:?usage: scripts/bump-version.sh [--build|--sync] <semver>}"
if ! [[ "$V" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev\.[1-9][0-9]*)?$ ]]; then
  echo "not a product version: $V" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
if [[ "$BUILD" == 1 ]]; then
  [[ "$V" == *-dev.* ]] || { echo "build stamping requires a dev version" >&2; exit 1; }
elif [[ "$SYNC" == 1 ]]; then
  [[ "$V" == "$(node scripts/release.mjs version origin/master)" ]] || { echo "sync only the current master version" >&2; exit 1; }
else
  [[ "$V" != *-* ]] || { echo "committed versions must be stable" >&2; exit 1; }
  [[ "$(git branch --show-current)" == master ]] || { echo "stable versions are bumped on master" >&2; exit 1; }
  if [[ -n "${CI:-}" ]]; then
    [[ "${GITHUB_WORKFLOW:-}" == "Release clients" && ( "${GITHUB_EVENT_NAME:-}" == workflow_dispatch || "${GITHUB_EVENT_NAME:-}" == push ) && "${GITHUB_REF:-}" == refs/heads/master ]] || {
      echo "only the master release workflow may bump a version in CI" >&2; exit 1;
    }
  fi
fi

FILES=(
  Cargo.toml                            # [workspace.package] version — every crate, the Tauri app included (version.workspace)
  apps/desktop/src-tauri/tauri.conf.json
  apps/desktop/package.json
  apps/server/package.json
  packages/ui/package.json
  package-lock.json                     # the three workspace members' version fields (see below)
)

for f in "${FILES[@]}"; do
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const version = process.argv[2];
    const original = fs.readFileSync(file, "utf8");
    let stamped;
    if (file === "package-lock.json") {
      const lock = JSON.parse(original);
      for (const key of ["apps/desktop", "apps/server", "packages/ui"]) {
        if (!lock.packages?.[key]?.version) throw new Error(`missing workspace version: ${key}`);
        lock.packages[key].version = version;
      }
      stamped = JSON.stringify(lock, null, 2) + "\n";
    } else if (file.endsWith(".toml")) {
      stamped = original.replace(/^version = "[^"]*"/m, `version = "${version}"`);
    } else {
      stamped = original.replace(/"version": "[^"]*"/, `"version": "${version}"`);
    }
    fs.writeFileSync(file, stamped);
  ' "$f" "$V"
  grep -q "$V" "$f" || { echo "FAILED: $f does not carry $V" >&2; exit 1; }
  echo "bumped  $f"
done

# Refresh the lockfiles so CI/bindings checks see the new member versions.
# `cargo update -w` touches only workspace members in the lock, external
# deps stay pinned. The Tauri app is a workspace member: one lock.
if command -v cargo >/dev/null; then
  cargo update -w --quiet
  echo "lockfile refreshed"
else
  echo "cargo not found — run 'cargo update -w' before committing" >&2
fi

echo
echo "All product versions set to $V. Verify with:"
echo "  git grep -n '$V' -- Cargo.toml 'apps/*/package.json' 'packages/*/package.json' 'apps/desktop/src-tauri/tauri.conf.json'"
