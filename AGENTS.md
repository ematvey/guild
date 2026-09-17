# AGENTS.md — Guild

Self-hosted org-level Codex/Cowork replacement: Rust workspace (cloud server,
local engine, shared protocol/core crates) plus a Tauri desktop client.
Layout, build/test commands, and API examples live in `README.md` — it is the
source of truth for them; this file carries only what the repo cannot tell
you.

## Read before touching the code

- **`PLAN.md`** — current state of work and the decisions behind it
  (approvals, exec policy, skills, thread events…). Newest entries on top.
  Read the top entries before changing the areas they cover.
- **`docs/deploy-nuances.md`** — deploy recipes, the compose stack on
  :18080, and the frontend-embedding model. Read before shipping anything.
- **`docs/clients.md`** — building, signing, and releasing desktop clients.
- **`docs/specs/`** — design docs; **`docs/plans/`** — milestone plans.
  Consult the matching one when working in that area.

## Conventions

- **Always redeploy after a change.** The user tests against
  `http://localhost:18080`; a local build or container restart ships
  nothing. Every task ends with the compose rebuild recipe from
  `deploy-nuances.md` §2 and a live-bundle check (§2 end). Run the rebuild
  detached — the cargo release build inside Docker is the long pole.
- **Sessions run this repo concurrently.** Check `git log` / `git status`
  for fresh commits before and after editing; pull/rebase rather than
  clobber.
- `PLAN.md` is the changelog of decisions. Code comments describe what code
  is and does now — no history narration in comments.

## Traps

- **Generated TS bindings**: `crates/protocol/ts/**` is generated
  (`TS_RS_EXPORT_DIR=ts cargo test -p protocol --features ts`). Never edit
  by hand.
- **Default cargo members exclude the Tauri app** (`apps/desktop`): its
  dependency tree dominates compile time. `cargo test/build` skip it —
  target it explicitly with `-p guild-desktop`.
- **Do not link `starlark` into the server runtime.** It enables
  `serde_json/arbitrary_precision` cargo-globally, which breaks internally
  tagged serde deserialization across the binary. Exec-policy rules are
  parsed at build time (guild-server `build.rs` → JSON in `OUT_DIR`); keep
  that indirection.
- **Server-side workspace sessions**: `run_command` is disabled unless
  `GUILD_ALLOW_SHELL_TOOLS=1`; machine `execute` calls go through the
  static exec-policy rules in `crates/server/assets/exec_policy_*.rules`
  before any approval gate.
