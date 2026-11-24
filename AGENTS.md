# AGENTS.md — Guild

Self-hosted org-level Codex/Cowork replacement: a TypeScript cloud server,
a Rust local engine with shared protocol/core crates, plus a Tauri desktop
client.

Layout and build/test commands live in `README.md`; API examples live in
`docs/api.md`. Those files are the source of truth for them; this file carries
only what the repo cannot tell you.

## Read before touching the code

- **`docs/domain/`** — the domain model: concepts, the rules each keeps,
  access, execution, capabilities and live state, in numbered documents
  read in order. Its terms are the project's vocabulary; a change to a
  concept or rule updates the matching document in the same commit.
- **`docs/deploy-nuances.md`** — deploy recipes, the compose stack on
  :18080, and the frontend-embedding model. Read before shipping anything.
- **`docs/clients.md`** — building, signing, and releasing desktop clients.
- **`docs/PRD.md`** and **`docs/SRS.md`** — what the product is and the
  system contracts that satisfy it.

## Conventions

- **Every chat/thread UI update arrives over the member WebSocket.** Any
  state the user sees change live — messages, run status, the subagent
  tree, the chat list, presence — is pushed as a `ServerFrame`
  (`WsServerMsg` in Rust and the server hub) on the member socket: inside
  the `sync` bracket for the first view, then on the store NOTIFY. Clients
  do not poll HTTP for state the socket carries, and a grandchild's event
  is pushed to every ancestor chat that displays it.
  New display state gets a frame variant in `protocol/socket.schema.json`
  (the contract) with a fixture in `protocol/fixtures/socket.ServerFrame.json`,
  the matching variant in `crates/protocol/src/ws.rs` and
  `packages/wire/src/types.ts`, its tag in `SERVER_TAG_NAMES`
  (`packages/wire/src/parse.ts`), a NOTIFY channel, a feed handler, and
  its place in the sync gate's deferred-frame classification
  (`DEFERRED_UNTIL_SYNC` in `apps/server/src/hub/protocol.ts`: held
  during a `sync` bracket or not).
  The server serializer (`apps/server/src/hub/protocol.ts`) is generic and
  needs no arm.
  The client applies the frame; it never re-fetches.
- **The server pushes all operational, status and chat state; clients never
  poll for it.** Machine online/offline, run status, unread, approvals,
  presence, registry lists — any fact the UI shows and that can change
  while the app is open — must reach the client as a server-initiated
  `ServerFrame` the moment it changes. An HTTP snapshot may seed the
  first paint, but it is never the live source: no timers, no interval
  refetches, no "refresh on focus" for state the socket can carry. A new
  operational fact is not done until it has a frame, a push site in the
  server, and a client handler.
- **All navigation state is URL state.** Every page, tab, panel and
  sub-page the user can reach has its own fixed URL (rail tabs, threads,
  projects, new chats per surface, skills pages, settings sections and
  sub-pages). Navigation never mutates local state without a matching
  history entry: deep link, reload and back/forward must land exactly
  where the user was. The route model is `ChatRoute`/`applyRoutePatch` in
  `apps/desktop/src/views/thread/route.ts` (driven by
  `thread/hooks/use-thread-route.ts`); the reference implementation of
  the contract is `apps/desktop/src/views/skills/skills-route.ts`.
- **Local iterations use local tools.** Run builds and checks on the
  development host. For app changes, rebuild the dev Compose stack at
  `http://localhost:18080` using `docs/deploy-nuances.md` §2. Run the rebuild
  detached and verify the served bundle. Run GitHub Actions or other CI only
  when the user explicitly requests CI or a release.
- **Signed desktop releases require an explicit request.** For a requested dev
  release, publish a prerelease from the working branch, approve it on the dev
  stack, and verify all four platforms in its updater manifest
  (`docs/clients.md` §4).
- **Committed versions change only in the master release workflow.**
  `scripts/bump-version.sh` updates the synchronized product version on `master`.
  Branch/local builds use `scripts/release.mjs preview` to stamp a temporary
  `-dev.<build-number>` version in an isolated worktree. Keep source version
  files unchanged on development branches; synchronize released versions from
  `master`. The **Version policy** CI check enforces these rules.
- **Review-loop branch topology:** `review/roundN-<agent>`, `fix/roundN`,
  `verify/roundN` worktrees, merged `--no-ff`; branches and worktrees are
  retired after merge, and orchestrator prompt/report files stay out of the
  repo root (reports live in git history).
- **Sessions run this repo concurrently.** Check `git log` / `git status`
  for fresh commits before and after editing; pull/rebase rather than
  clobber.
- **Never touch prod while developing.** Dev tasks act on the dev stack
  only (`:18080`, `compose`, db `guild` — including its release registry;
  publish client releases to dev so the dev-paired desktop sees them).
  The prod stack (port 18081, its own checkout, database `guild_live`) is only
  touched when the user explicitly asks for a prod deploy/release.
- **Type sizes come from the theme scale.** `packages/ui/src/theme.css`
  declares the only steps (`text-3xs` … `text-2xl`). Views use those names;
  no raw `text-[Npx]`/`text-[Nrem]` sizes. Resize text by editing the token.
  Do not scale the interface with `html { font-size }` or `zoom`: both move
  layout and spacing, not just text. `docs/type-scale.md` maps every role —
  prose, chrome, titles, metadata, dense data, micro labels — to a step and
  an icon size; a new element takes a role from that table.
- **Integration icons use official brand assets.** Copy the icon from the
  provider's brand kit, website, or official repository into the integration's
  `logo.svg` and record the source URL in an SVG comment. When the provider
  publishes no icon, use the existing generic fallback.
- **No personal identifier in a document, a comment, a fixture or a test.**
  A person, a machine, a company or a host is a placeholder: `alice`/`bob`,
  `user@example.com`, `/home/user`, `C:\Users\alice`, `WORKSTATION-A`,
  `guild.example.com`. A real address, name, home directory, mount point or
  hostname lives in the deployment configuration on the host and never in a
  commit — an example that needs to look real uses the documentation
  domains (`example.com`, `example.org`, `example.test`).
  `scripts/check-identifiers.py` fails the gate on a listed identifier or on
  an email domain outside those.
- **Documents and comments describe the present.** A document states what
  the system is and does now. It does not narrate a migration, name a
  retired component, explain why an earlier design was dropped, or carry a
  changelog; git history holds that. When a rule changes, rewrite the
  sentence that states it — do not append a note about the change.

## Traps

- **Wire types are hand-written**: `packages/wire` on the TypeScript side,
  `crates/protocol/src` on the Rust side, both from `protocol/*.schema.json`.
  Nothing generates TypeScript from Rust.
- **Default cargo members exclude the Tauri app** (`apps/desktop`): its
  dependency tree dominates compile time. `cargo test/build` skip it —
  target it explicitly with `-p guild-desktop`.
- **Server-side tools run in gVisor sandboxes** (workspace sessions and
  plain chats) via the `sandbox-runner` compose service — never in the
  server process. Production refuses `GUILD_SANDBOX=inprocess-unsafe` and
  requires a runner (there is no disabled mode); the
  test suite uses it by default. Sandbox integration tests need the host's
  `runsc` runtime: `scripts/sandbox-it.sh`. Shell calls still go through
  the static exec-policy rules in `apps/server/assets/exec_policy_base.rules`
  (TS matcher) before any approval gate.
