# scripts

Run every script from the repo root. Each file's header comment has the full
usage.

## Gate and release

| Script | What it does |
| --- | --- |
| `check.sh` | The quality gate: every baseline check concurrently, one summary (`--fast`, `--only <name>`). |
| `check-windows.sh` | Windows compile check for the engine; exits 2 (SKIP) without the `x86_64-pc-windows-gnu` target. Run by `check.sh`. |
| `coherence/` | The coherence floor and domain model (`npm run coherence`); see `coherence/README.md`. |
| `bump-version.sh <semver>` | Sets the committed product version on master; `--sync` synchronizes master’s version; `--build` stamps a disposable preview (`docs/clients.md` §4). |
| `release-clients.sh` | Local preview entry point; cross-builds all six signed desktop artifacts through the isolated release orchestrator. |
| `release.mjs` | Version policy, automatic release support, pinned preview retention (`pin`, `prune`), isolated preview builds, native artifact collection and complete GitHub publication and deployment pairing (`publish-running`); `configure` installs the repository rule and master-only release credentials (`--help`). |
| `release.test.mjs` | Executable version-policy and publication checks (`node --test scripts/release.test.mjs`). |
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
