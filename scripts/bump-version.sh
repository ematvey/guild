#!/usr/bin/env bash
# Set the product version everywhere it lives, in one step. The list of
# files is the contract — see docs/deploy-nuances.md §10 for the why and
# the per-file details.
#
# Usage: scripts/bump-version.sh <semver>   e.g. scripts/bump-version.sh 0.5.38
set -euo pipefail

BUILD=0
if [[ "${1:-}" == "--build" ]]; then BUILD=1; shift; fi
V="${1:?usage: scripts/bump-version.sh [--build] <semver>}"
if ! [[ "$V" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev\.[1-9][0-9]*)?$ ]]; then
  echo "not a product version: $V" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
if [[ "$BUILD" == 1 ]]; then
  [[ "$V" == *-dev.* ]] || { echo "build stamping requires a dev version" >&2; exit 1; }
else
  [[ "$V" != *-* ]] || { echo "committed versions must be stable" >&2; exit 1; }
  [[ "$(git branch --show-current)" == master ]] || { echo "stable versions are bumped on master" >&2; exit 1; }
  if [[ -n "${CI:-}" ]]; then
    [[ "${GITHUB_WORKFLOW:-}" == "Release clients" && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REF:-}" == refs/heads/master ]] || {
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
  if [[ "$f" == *.toml ]]; then
    sed -i 's/^version = ".*"/version = "'"$V"'"/' "$f"
  elif [[ "$f" == "package-lock.json" ]]; then
    # Only the workspace members carry the product version in the npm lock;
    # every other "version" there belongs to a dependency. A stale member
    # version makes `npm install` rewrite the lock, which the client release
    # refuses as a dirty tree.
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const v = process.argv[2];
      const lock = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const key of ["apps/desktop", "apps/server", "packages/ui"]) {
        const entry = lock.packages?.[key];
        if (entry && entry.version) entry.version = v;
      }
      fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
    ' "$f" "$V"
  else
    sed -i '0,/"version": ".*"/s//"version": "'"$V"'"/' "$f"
  fi
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
