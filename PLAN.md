# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a TypeScript cloud
server, a Rust local engine with shared protocol/core crates, and a Tauri
desktop client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. The
decision log is the changelog: each entry says what changed and why, newest
first. Code comments describe only the present.

## Latest decisions

- **The turn body carries no AGENTS.md chain (2026-10-22).** Removed
  `agents_md` end to end: the webview no longer assembles the config-dir
  file plus the project chain, the turn body has no field for it, the Rust
  protocol and the engine forwarding drop it, and the TS server no longer
  accepts it. The field was dead once the workspace-config model landed —
  the server ignored it, so no turn ever saw the chain. Instructions come
  from the agent workspace files only.

- **Activity is an admin surface (2026-10-22).** The rail entry, the
  `/activity` page, the trace and session deep links, and each agent's
  Activity tab are admin-only. A member who lands on one of those addresses
  is moved to the agents directory (or the agent's Overview tab) with
  `replaceState`, so Back does not bounce. The server keeps its row scoping
  (members read their own rows) as defense in depth. Verified live with a
  member account: no rail entry, `/activity` lands on `/agents`, and the
  agent Activity tab is absent.

- **Composer typing stays cheap on long threads (2026-10-22).** A keystroke
  re-renders the whole chat view, and a 3000-event thread holds thousands of
  markdown blocks. `WebChat` now memoizes the transcript element list, so an
  unchanged thread keeps identical element objects and React bails out of
  that subtree. Measured on the 3000-event dev thread: one keystroke went
  from 23 ms to 4 ms (median, headless Chrome).

- **Security hardening pass (2026-10-22).** The review in
  `docs/reviews/2026-10-22-security-review.md` drove one batch of fixes. The
  Rust clients move to `rustls` 0.23.46, `rustls-webpki` 0.103.16 and the
  1.0.10 root bundles (distrusted-intermediate and TLS advisories); the
  dev-only npm tree moves to `vite` 7.3.7 and `vitest` 4.1.12 (audit now
  clean). `POST /api/v1/auth/login`, `/auth/bootstrap` and `/auth/pair` now
  pass a per-email and per-address sliding-window failure counter
  (`platform/http/login-throttle.ts`); ten failed logins on one email answer
  429 for the rest of the window. `loadConfig` refuses the example
  placeholders (`change-me`, the all-zero master key) when
  `NODE_ENV=production`, and the example config now says to generate real
  values. The user-MCP URL guard resolves the hostname and rejects every
  private address (allowlist: `host.docker.internal` plus
  `GUILD_MCP_ALLOWED_HOSTS`; RFC 2606 names pass because they never
  resolve). The SPA and the Tauri webview carry a CSP and the standard
  security headers. The global body limit drops to 1 MiB; the four upload
  routes keep their own larger limits. Attachment content types must match a
  MIME token. The internal gateway key compares in constant time. Left
  open by design: skill bundles publish without review (spec §1.3), and the
  file tools can read any path on a paired machine (the pairing is the
  grant).

- **Observability is one Activity surface: traces and spans, not a settings
  page (2026-10-22).** ClickHouse now owns the agent-observability model.
  `agent_traces` mirrors `agent_runs` (ReplacingMergeTree, 180-day TTL):
  trace id, org/user/agent, session (chat), parent trace, trigger, status,
  summary, error, start/finish. `agent_spans` holds immutable `llm` and
  `tool` spans (90-day TTL) with trace/span ids, parent span, model,
  tokens, cost, duration, status, input/output and attributes; the gateway
  writes LLM spans and the tool-task hook writes tool spans. One id links
  the story: the runtime resolves the chat's running run and sends
  `x-guild-run-id`, so every model call inside a turn carries the trace id
  and a judge call resolves it at settle time. A plain chat call falls back
  to the chat id as its trace id, and the chat id is always the session.
  `llm_calls` is retired for reads and writes; `llm_payloads` stays keyed by
  the request id (= LLM span id) and remains opt-in. API: `/api/v1/activity/
  {traces,spans,sessions,summary}` plus trace detail and admin-only span
  payloads; admins see the org, members their own rows. UI: the agents
  Activity page (and each agent's Activity tab) is now Traces | Calls |
  Sessions with a period picker, status/trigger/caller/model/search filters
  in the URL query, summary cards, a trace timeline, a transcript, and a
  span detail pane (input, output, attributes, payloads). The trace detail
  keeps `/runs/<id>`; `/settings/observability*` redirects to `/activity`.
  The settings section, its route contract and its test are removed. The
  model follows Laminar's trace/span/session vocabulary so the UI reads like
  modern agent observability rather than an LLM-call table. The agent turn
  route opens the run before `submitTurn`; `submitTurn` no longer opens a
  second one for adopted chats (each turn used to produce two runs and two
  traces). The surface keeps its status, duration, model and token data at
  the 900px desktop width, the timeline uses the trace's millisecond axis,
  and counts use singular forms. The trace detail now has Transcript, Tree
  and Timeline views: the transcript renders the run's user, assistant and
  tool steps and links each step to its span, and the tree nests tool spans
  under the model call that preceded them. Sessions get their own
  `/sessions/<id>` page with the session totals and its traces. The trace
  detail is a Laminar-style two-pane view: dense transcript rows show tool
  commands and result previews, the tree has aligned columns and one-line
  span previews, the timeline has a ruler and grid, and the span pane shows
  role-colored chat messages plus a syntax-highlighted JSON viewer with
  expand-all/collapse-all. The trace page uses the full window width with an
  adaptive span pane; input, output and attributes stack in one scroll
  instead of tabs. The trace view and the span pane scroll independently on
  wide windows, and the header stays fixed. The header title is the first
  line of the run summary; the full summary folds out in the trace pane.
  Desktop 0.5.99 carries it to installed clients.

- **A long thread reaches the client in pages (2026-10-22).** The member
  socket's ThreadState frame carried every durable event, and a live turn
  republishes that frame on each buffer change — so a long chat paid its
  whole history on every publish. The frame now carries the newest 120
  events and sets `has_more_events`; `GET /api/v1/threads/:id/events?
  before=&limit=` serves the page before a cursor. The client prepends a
  page when the reader scrolls to the top (or presses the top button),
  keeps the scroll anchor, and re-derives the merged window so cross-page
  tool results and approval decisions still join their blocks. A reconnect
  re-derives from the frame's own window: merging a loaded page onto a
  possibly non-contiguous tail could hide the rows between them. The full
  log stays on `GET /threads/:id` for the engine's turn assembly.

- **Agent config lives in the workspace, OpenClaw-style (2026-10-21).** The
  agent's identity, persona and operating rules moved out of the `agents`
  row into root files that the agent itself can edit: `IDENTITY.md` (one
  line: name, vibe, emoji, avatar), `SOUL.md`, `AGENTS.md`, `USER.md`,
  `MEMORY.md`, `BOOTSTRAP.md`, plus an empty `memories/`. Every new agent is
  seeded from the templates in `apps/server/src/agents/templates.ts` (never
  overwriting an existing file), and the thread's instructions are composed
  from the files on each turn (8 KiB per file, 24 KiB total, truncation and
  missing-file markers). `BOOTSTRAP.md` is a first-run ritual the agent
  deletes. The `agents.instructions` column is gone (migration 0086):
  `AGENTS.md` in the workspace is the only copy, and the UI reads the
  identity line (`identity` on the agent payload). Spec:
  `docs/specs/2026-10-21-workspace-agent-config.md`; re-seed a dev install
  with `npx tsx scripts/agents-reinit.ts`.

- **A skill pin is optional; an install follows the latest by default
  (2026-10-21).** `skill_installs.pinned_version` is nullable and NULL means
  "follow the latest published version". Every install path — the install
  route with no version, `read_skill`'s install-on-use, `push_skill`'s
  auto-install, `autoInstall` after a publish — now writes NULL, so a
  publish reaches every unpinned install without a re-install. An explicit
  `POST /api/v1/skills/:slug/pin` is the only writer of a version. The
  index says "(installed, latest)" for an unpinned row, the desktop badge
  says "✓ latest", and the detail page's update button only appears for an
  explicit pin that sits behind the latest.

- **The chat column resizes; the tail has a jump button (2026-10-21).** The
  central column was pinned to `max-w-3xl`. A drag handle on its right edge
  now sets one width for the message list, the composer and the loading
  skeleton; it persists in localStorage (`guild.chatWidth`), resets on
  double-click and nudges with ArrowLeft/ArrowRight. A floating button
  appears above the composer when the pane is scrolled away from the bottom
  and smooth-scrolls back to the tail.

- **Skill files never enter an agent workspace (2026-10-21).** A workspace
  belongs to the agent and outlives the conversation, so the turn-start
  materialization loop now skips agent-backed chats; a plain chat's
  throwaway sandbox still receives the pinned bundle. `read_skill` serves
  the registry bundle instead: the SKILL.md plus the additional files
  inline (binary files and files past a 160 KiB budget stay listed by name
  and sha256). An agent that wants to edit a skill writes its own
  `skills/<slug>` tree; a present local tree still wins over the registry
  and `push_skill` publishes it. Copies that earlier turns left in agent
  workspaces were removed.

- **Coding tools are direct; integrations stay script-only (2026-10-21).**
  The model calls `read`, `write`, `edit`, `list`, `bash`, `web_search` and
  the skill tools itself. Integration, MCP and thread-history tools stay
  behind `codemode` scripts. The agent's tool allowlist narrows the direct
  surface the same way it narrows integrations, and `codemode` is always
  present because it is the only path to the script-only tools.

- **Stop ends the turn even when a tool cannot be cancelled (2026-10-21).**
  The stop route waits for the conversation to go idle, so one hung tool call
  kept the chat generating and the button on "Stopping" for good. Three
  holes are closed. The attach handshake to the sandbox runner rejects on
  error or close (ws reports a failed handshake with the socket already
  CLOSING, so the old ready-state check never fired) and has a 30 s ceiling.
  A sandbox call stops waiting for the connection when its context aborts;
  the shared connect keeps running for the next call. The runner's Docker
  calls and the agent exec start have timeouts. Past 10 s without a settled
  stop, the supervisor kills the worker: the abort mark is already durable,
  so the respawned worker commits the aborted outcomes from the journal.

- **A volume remount no longer wedges the agent sandboxes (2026-10-21).**
  The JuiceFS sidecar remounts `/mnt/guild` in the host namespace on every
  start, which leaves the Docker bind volume's `_data` on the dead FUSE
  session. Every command in a sandbox then blocks or fails with
  `transport endpoint is not connected`, and the chat turn hangs. The
  sidecar now re-binds `_data` for each volume whose device is the mountpoint
  before it reports healthy, and the sandbox runner removes its project's
  sandbox containers on boot instead of adopting them (a container created
  before the remount keeps the dead session; its files stay on the volume).
  No manual `umount`/`mount --bind` step remains.

- **Chats pick their agent (2026-10-21).** The composer's model selector is
  gone. A chat shows its agent and can switch it from a dropdown
  (personal agent first, then agents the user can use; a shared agent carries
  a users icon). `GET/POST /api/v1/threads/:chatId/agent` reads and sets the
  binding; the turn body accepts `agent_id`. A plain chat is adopted by the
  caller's personal agent on its first turn; switching an existing chat keeps
  the transcript and moves the thread to the chosen agent. The model is the
  agent's, never a per-chat choice.

- **A personal agent is visible only to its owner (2026-10-21).** — no admin override, no
  org or team visibility. `visiblePredicate` handles `is_personal` first.

- **Threads are private; agents are shared (2026-10-21).** Design:
  `docs/specs/2026-10-21-unified-threads.md`. Every conversation is a thread of
  an agent; a thread carries the user on whose behalf it exists (caller for a
  message, routine creator for a cron run, parent's user for a delegation).
  Sharing an agent shares its workspace, never its threads.
  - `agent_threads.user_id` scopes every thread read, rename and turn; a
    second user of a shared agent gets their own default thread
    (`UNIQUE (agent_id, user_id) WHERE kind = 'default'`) and cannot see,
    rename or post into another user's thread. Verified live: a member of an
    org-visible agent reads the owner's thread as 404.
  - `agent_routines.created_by_user_id` and `agent_runs.user_id` record the
    run's user, so routine threads and inbox notices land in the creator's
    private list.
  - `agents.is_personal` marks the one personal agent per user (default name
    `Assistant`), created lazily on first use, always private, exempt from
    archive and delete. `MAX_AGENTS_PER_ORG` is gone: agent count is
    unbounded; limits are workspace quota and storage budget.
  - Agent list shows `owner / name`; names are unique per owner among live
    agents. Model labels always use the app alias (`Auto`), never the
    provider id.

- **Type sizes come from the theme scale (2026-10-21).** `packages/ui/src/theme.css`
  declares the only text steps: `text-3xs`, `text-2xs`, `text-xs`, `text-sm`,
  `text-base`, `text-lg`, `text-xl`, `text-2xl`, with unitless line-height
  ratios. Views use those names and never a raw `text-[Npx]`/`text-[Nrem]`
  size. To resize text, change the token — one value, every use.
  `html { font-size }` scaling is not a size control: it moves layout and
  spacing too, and it is banned.

- **Agent surfaces follow the chat product (2026-10-21).**
  - Agent threads render through the core chat stack: `/agents/<id>/threads/<tid>`
    resolves the thread's `chat_id` and feeds the normal transcript, tool
    frames, approvals, attachments and composer. The header keeps the agent
    identity and thread rename; sends go to `/agents/<id>/turns` with the
    command id, attachment ids and queue/steer mode, so agent runs still get
    their `agent_runs` row and the agent's model.
  - Routines are view-only in the UI. `list_routines`, `create_routine`,
    `update_routine` and `delete_routine` are agent tools; the Routines page
    opens a chat prompt for new/edit flows and renders human-readable
    schedules (cron stays stored, never shown as the primary label).
  - Codemode is part of the runtime, not an allowlist toggle. It is removed
    from the agent tool catalog and from existing `agents.tools`; the
    settings page says it is always available. Integration tools from
    enabled org integrations are listed in the catalog and selected per
    agent; the runtime narrows the integration extension and discovery list
    to the agent's allowlist, so unselected tools are neither declared nor
    callable.

- **Persistent agents are live on the local compose stack (2026-10-20).**
  Agent workspaces are a JuiceFS volume mounted in the **host mount
  namespace** by the privileged `pid: host` sidecar (`nsenter -t 1 -m -n`),
  because the Docker daemon and the sandbox runner resolve bind sources on
  the host. The server keeps a read-only `/workspaces` mount and a
  read-write `/workspaces-write` used only for delegation artifacts and
  purge; the runner creates always-on gVisor sandboxes under
  `agents/<org>/<agent>`. A host-namespace sweep keeps a 50 GiB JuiceFS
  quota on every agent directory. Restarting the sidecar requires remounting
  Docker's bind volume (docs/deploy-nuances.md §4b).
  - Delegation is worker-per-chat: a parent worker cannot admit a child
    chat, so admission is proxied over the fork IPC (`remote-submit`).
    Artifacts are written through the read-write mount and surface on the
    parent run (`run_id OR parent_run_id`).
  - Team visibility stores explicit `agent_team_grants`; the create wizard
    and settings both pick teams, and settings clear grants when visibility
    leaves `team`.
  - Delete is two-phase: `deleting` + `purge_after` (30-day default), the
    scheduler purges due agents and removes the workspace directory;
    archive and deleting agents are both restorable from the directory.
  - One-shot routines delete stale pending occurrences on disable,
    reschedule, manual run, or auto-disable. `send_message` dedupes the same
    agent/title within a minute. The inbox rail badge refreshes when a
    notice is read.
  - Limits: 2 vCPU / 2 GiB / 512 pids per sandbox (runner defaults,
    env-tunable), a 50 GiB JuiceFS quota per agent workspace; agent count is
    unbounded. `agents.resources` is recorded but not enforced.

- **Agent workspaces get a JuiceFS volume (2026-10-20).** Compose adds a
  `juicefs` sidecar (foreground mount, `/dev/fuse`, `SYS_ADMIN`, unconfined
  AppArmor, `rshared` host dir, `stat -f` healthcheck) and a one-shot
  `juicefs-init` that creates the dedicated `guild_meta` Postgres database.
  The `guild_workspaces` volume binds `${GUILD_WORKSPACE_HOST_DIR:-/mnt/guild}`;
  the server mounts it read-only at `/workspaces`, the runner read-write.
  The runner accepts `agents/<org>/<agent>` subpaths, creates their dirs on
  the agent volume, and never reaps them: agent sandboxes are always-on.
  `GUILD_AGENT_WORKSPACE_ROOT` is the server's file-browser root. The
  isolated instance (`scripts/agents-vfs-init.mjs`) is project
  `guild-agents-vfs`, :18093, db `guild_agents_vfs`, bucket
  `guild-agents-vfs`, dir `/mnt/guild-agents-vfs`; its only host
  prerequisite is `sudo mkdir -p /mnt/guild-agents-vfs`.

- **Skill provenance reaches the agent (2026-10-20, 0.5.83).** An agent
  asked "whose skill is that?" and could only answer from the SKILL.md's
  prose, because the index, `search_skills` and `read_skill` dropped the
  registry's provenance. Every agent-facing surface now carries it: the
  machine's index line reads the install sidecar (`agents/guild.yaml`) and
  appends `[registry v2, published by X, on <date>, installed <date>]`, or
  `[local]` for a folder Guild never installed; the sync payload carries
  `publisher` and `published_at` into that sidecar, and
  `skill_installs`-driven pushes refresh it. Server-side, `searchSkills`
  returns the latest version's publisher label, publish time, owner label
  and fork origin (a new `SkillSearchRow`; `listItems` keeps its lean wire
  shape), the index org lines name the publisher, `search_skills` prints a
  provenance line per hit, and `read_skill` opens with a `Provenance:`
  paragraph — version, publisher, date, owner, fork origin, bundle sha.
  `itemControl` and `getVersionMeta` resolve owner and publisher labels, so
  the local-tree read names the owner too. Index guidance states the
  provenance is there.

- **The 2026-10-18 review's criticals are closed (2026-10-19, 0.5.82).**
  Project binding is owner-only: `lockBindableMachine` matches the machine's
  `user_id`, with the org kept as a tenancy filter — a project's folder is the
  workdir its chats execute in, so an org-wide bind was remote execution on a
  coworker's machine. An unmapped conversation now blocks command-bearing
  tools instead of failing open; non-command tools keep the pre-approved
  batch contract. The composer ignores Enter while an IME is composing. A
  malformed path escape parses to the default route and the address is
  rewritten, instead of throwing from the render-time route initializer. The
  route upsert runs in one transaction, so a rename onto a taken id or
  display name is a 409 from the index, not a lost race or a 500. Route
  display names are unique per org (case-insensitive; the empty default may
  repeat), and the context tooltip names the route that actually measured the
  usage instead of the currently selected one.

- **A turn naming a retired model runs on the default route (2026-10-19).**
  A chat pins no model: the picker offers the org's catalog, and the turn
  carries whatever the client has in hand. A tab opened before an admin
  changed the routes (or an older desktop bundle) kept sending the old id and
  the submission failed at `resolveRoute`. Submission now resolves the
  request against the org's enabled routes — a name still on the list is used
  as sent, anything else falls back to the default (first) route — so the
  turn succeeds and its assistant event records the model that actually ran.
  Dev's only route is aliased `Auto`, so the picker reads Auto while the wire
  id stays `deepseek-v4.1-flash`.

- **Model routes carry a user-visible name; the model id stays internal (2026-10-19, 0.5.81).**
  `model_routes.alias` is the display name the chat model picker, context
  ring and route pages show; the `model` column remains the wire id sent to
  the provider and the identifier API clients address. `/api/v1/models` keeps
  returning the id list for older clients and the Rust engine, plus an
  `aliases` map; a route without an alias falls back to its id until an admin
  names it. The admin route form now edits both fields, and a changed id
  renames the existing row in place (a rename onto an existing id is a 409,
  not an overwrite). Old thread entries and usage rows keep the historical
  id; that is data, not a live route reference. Dev compose serves 0.5.81,
  the migration is applied, and all six signed client artifacts are
  published.

Older decisions (before 2026-10-19): `docs/archive/decisions.md`.

## Where things stand

- **Server:** a TypeScript Fastify app on `pi-durable`, run by Bun with no
  compile step. The compose stack on `:18080` (`deploy/compose`) serves the
  API and the chat SPA baked into the image from `apps/desktop/dist`. State
  lives on the host services: Postgres db `guild`, ClickHouse for traces and
  usage, rustfs for objects. Agent workspaces ride a JuiceFS volume; tools
  run in gVisor sandboxes via `sandbox-runner`.
- **Version:** dev runs 0.5.103. Prod is a separate checkout
  (`~/guild-prod`, branch master, `:18081`), runs 0.5.82, and stays in
  supervisor mode; dev runs worker mode (`GUILD_WORKER_MODE=on`).
- **Clients:** desktop 0.5.103 is published on the dev updater manifest for
  all four platforms (six artifacts: Windows NSIS, Linux AppImage, macOS
  aarch64 and x86_64 DMG plus their updater bundles), minisign-signed.
  Installed clients pick it up on relaunch. Releases stay dev-controlled and
  deliberate.
- **Product surface:** private threads and shared persistent agents; org
  skills with provenance; projects, machines and agent routines. Admin
  sections live inside Settings (`/settings/<section>`); there is no
  separate admin app. Observability is the Activity surface, fed by traces
  and spans from ClickHouse.
- **Quality baseline:** `cargo test --workspace`, the TS server suite
  (`npm test --workspace apps/server`), desktop vitest, strict clippy, the
  Windows compile check (`scripts/check-windows.sh`) and the bindings
  freshness gate (`scripts/check-bindings.sh`).

## Next steps (ordered)

1. **Finish the worker-mode soak.** Dev serves turns through forked
   workers, so every agent turn rides this path. Still unverified: idle
   reap, and live approval, compaction and steering inside a worker turn.
   Prod is not in scope — agent work is tested on dev only.
2. **Enforce agent resource limits, or drop the field.** Every agent records
   `resources` (1 vCPU / 2 GiB / 256 pids / 50 GiB), but the sandbox runner
   ignores it and uses its own env defaults (2 vCPU / 2 GiB / 512 pids). The
   per-agent 50 GiB JuiceFS quota is the only limit that actually applies.
   Decide: pass `resources` into the sandbox spec, or remove the field.
3. **Set an org storage budget for shared agent workspaces.** The 50 GiB
   quota is per agent, and agent count is unbounded, so one org can fill the
   object store. Decide the budget and where it is enforced.
4. **Decide whether an archived thread can move to another agent.** Today a
   live thread moves with its transcript; an archived one has no such path.
5. **Decide machine identity after an OS reinstall.** A changed hardware
   fingerprint matches no row, so the machine registers as new and its old
   chats go dark. Candidates: derive the fingerprint from the firmware/board
   UUID, or give the user an explicit takeover on the machines page.
6. **Measure the rest of the long-thread path.** Composer typing is fixed.
   Initial load and scroll of the 3000-event dev thread were not measured.
7. **Cover the review gaps in the next loop:** Windows-only engine paths
   (compile-checked, never run), the desktop updater flow on a real install,
   and the integration connectors.

## Future directions

- **Decide the skill scope: per-user installs or per-agent sets (open,
  2026-10-21).** Installs and pins are per user today, and a chat resolves
  them through its owner (`identity` in `apps/server/src/harness/skills.ts`),
  so two people who use the same shared org agent get two different skill
  sets and two different pins from it. The alternative mirrors the existing
  tool pattern: `agents.skills` (JSONB slug list) plus `agents.skills_mode`
  (`selected` | `all`), with personal agents defaulting to `all`. That
  costs a migration, the four call sites in `harness/skills.ts`, the agent
  create/update routes, the agent settings UI, and a new source for the
  machine-sync payload (the union of the skill sets of the agents a user
  can run). Kept per-user for now: pins are optional and installs follow
  the latest, so the wrong-scope damage is small. Revisit when a shared
  agent needs a fixed skill set for everyone.

- **Schema-first protocol types (protobuf or similar), dropping the
  Rust-side ts-rs generation** (maintainer, 2026-10-14): define the wire types
  once in a language-neutral IDL and generate both the Rust and TS types
  from it, instead of Rust being the source of truth with ts-rs emitting
  `crates/protocol/bindings/*.ts`. Removes the npm-workspace-inside-crates
  oddity and the per-type export tests. Precondition for picking the tool:
  it must preserve the freshness gate (generated-vs-committed diff) and the
  64-bit wire-field number handling (`ts(type = "number")` today).

- **Wire field renames (`chat_id` → `thread_id`) are still open.** The
  routes and client paths moved to threads in 0.5.47; the wire fields did
  not. Any rename is a client/server coupling decision, so it ships as one
  deliberate release.

- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `2026-09-24-loop-summary.md` (git history) for the per-surface pass counts
  and the process playbook (mixed reviewers; pi fixer/verifier; verifier
  rebuilds exploit chains against the real caller; env var gotcha:
  `GUILD_TEST_PG_URL` is a base URL without a db suffix).

- **Engine/product direction unchanged:** one agent loop, thin desktop
  backend, project-derived executor binding, durable Restate workflows. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.

## Working conventions

- **Always redeploy after a change** — detached compose build+up from
  `deploy/compose`, then verify the live bundle hash and API health. The
  user tests against :18080.
- **Desktop-affecting changes ship a client release in the same task** —
  `scripts/release-clients.sh` against the dev manifest, then check
  `latest.json`.
- **Bump the version with `scripts/bump-version.sh <semver>`**, never by
  hand; the script covers every file the health endpoint and release
  scripts compare.
- **Sessions run this repo concurrently** — check `git log`/`git status`
  before and after editing; pull rather than clobber.
- **Review-loop branch topology:** `review/roundN-<agent>`, `fix/roundN`,
  `verify/roundN` worktrees under `~/guild-wt/`, merged `--no-ff`, branches
  and worktrees retired after merge; orchestrator prompt/report files stay
  out of the repo root (reports live in git history).
- Comments describe what code IS and does now — no history narration. Docs
  like this file carry the story.
