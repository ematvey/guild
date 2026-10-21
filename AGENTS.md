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

- **All navigation state is URL state.** Every page, tab, panel and
  sub-page the user can reach has its own fixed URL (rail tabs, threads,
  projects, new chats per surface, skills pages, settings sections and
  sub-pages). Navigation never mutates local state without a matching
  history entry: deep link, reload and back/forward must land exactly
  where the user was. The route model is `ChatRoute`/`pushRoute` in
  `apps/desktop/src/views/WebChat.tsx`; the reference implementation of
  the contract is `apps/desktop/src/views/skills/skills-route.ts`.
- **Always redeploy after a change.** The user tests against
  `http://localhost:18080`; a local build or container restart ships
  nothing. Every task ends with the compose rebuild recipe from
  `deploy-nuances.md` §2 and a live-bundle check (§2 end). Run the rebuild
  detached — the cargo release build inside Docker is the long pole.
- **Desktop-affecting changes always get a desktop release, same task.**
  Anything that lands under `apps/desktop/` (or anything else baked into
  the client) must end with a client release cut from `develop` and
  published to the dev updater manifest (`scripts/release-clients.sh`,
  `docs/clients.md`) — not just the compose deploy. A web-only deploy
  leaves every installed client on the old bundle, which reads as
  "my fix didn't work". The flow is: commit → compose rebuild → client
  release → verify `latest.json` serves the new version.
- **Sessions run this repo concurrently.** Check `git log` / `git status`
  for fresh commits before and after editing; pull/rebase rather than
  clobber.
- **Never touch prod while developing.** Dev tasks act on the dev stack
  only (`:18080`, `compose`, db `guild` — including its release registry;
  publish client releases to dev so the dev-paired desktop sees them).
  The prod stack (`:18081`, `~/guild-live`, db `guild_live`) is only
  touched when the user explicitly asks for a prod deploy/release.
- **Type sizes come from the theme scale.** `packages/ui/src/theme.css`
  declares the only steps (`text-3xs` … `text-2xl`). Views use those names;
  no raw `text-[Npx]`/`text-[Nrem]` sizes. Resize text by editing the token.
  Do not scale the interface with `html { font-size }` or `zoom`: both move
  layout and spacing, not just text.
- `PLAN.md` is the changelog of decisions. Code comments describe what code
  is and does now — no history narration in comments.

## Traps

- **Generated TS bindings**: `crates/protocol/bindings/**` is generated
  (`cargo test -p protocol --features ts`; check freshness with
  `scripts/check-bindings.sh`). Never edit by hand.
- **Default cargo members exclude the Tauri app** (`apps/desktop`): its
  dependency tree dominates compile time. `cargo test/build` skip it —
  target it explicitly with `-p guild-desktop`.
- **Server-side tools run in gVisor sandboxes** (workspace sessions and
  plain chats) via the `sandbox-runner` compose service — never in the
  server process. Production refuses `GUILD_SANDBOX=inprocess-unsafe`; the
  test suite uses it by default. Sandbox integration tests need the host's
  `runsc` runtime: `scripts/sandbox-it.sh`. Shell calls still go through
  the static exec-policy rules in `apps/server/assets/exec_policy_base.rules`
  (TS matcher) before any approval gate.
