# scripts

Run every script from the repo root. Each file's header comment has the full
usage.

## Gate and release

| Script | What it does |
| --- | --- |
| `check.sh` | The quality gate: every baseline check concurrently, one summary (`--fast`, `--only <name>`). |
| `check-windows.sh` | Windows compile check for the engine; exits 2 (SKIP) without the `x86_64-pc-windows-gnu` target. Run by `check.sh`. |
| `coherence/` | The coherence floor and domain model (`npm run coherence`); see `coherence/README.md`. |
| `bump-version.sh <semver>` | Sets the product version in every file that carries it (`docs/deploy-nuances.md` §10). |
| `release-clients.sh` | Builds, signs and publishes the desktop client for every OS, then tags and pushes `client-v<VERSION>` (`docs/clients.md` §4). |
| `zig-link-dedup.sh` | Linker wrapper `release-clients.sh` uses for the macOS builds: drops repeated `-framework` flags before zig links. |
| `sandbox-it.sh` | Sandbox integration tests against a real runner, gVisor and the egress proxy; needs `runsc` on the host. |

## Operations

These act on a live database or workspace volume. Point them at the dev
stack unless the task is explicitly about prod.

| Script | What it does |
| --- | --- |
| `agents-reinit.ts` | Resets every agent's `AGENTS.md` from the template (`--org`, `--dry-run`). |
| `durable-repair.mjs` | Audits pi-durable document chains; `--fix` rebuilds a damaged live projection from the durable tasks. |
| `agents-vfs-init.mjs` | Provisions the fixed resources of the disposable `guild-agents-vfs` verification stack on :18093 and refuses any other target (`docs/deploy-nuances.md`). |
