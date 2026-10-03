# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a Rust workspace (cloud
server, local engine, shared protocol/core crates) plus a Tauri desktop
client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. History is
not kept here — it lives in git and in `docs/reviews/`.

Updated 2026-10-04.

## Latest decisions

- **TS server rebuild on pi-durable starts (2026-10-04).** The cloud server
  is rebuilt in TypeScript on `@earendil-works/pi-durable` (pinned `1.0.1`,
  never forked, no upstream fix loop); Restate is dropped; the public API,
  platform schema (existing Postgres tables verbatim), and concepts stay the
  same. Staged cutover with the TS server in front proxying un-ported routes
  to the Rust server; Rust retires at parity. Thread history imports into
  durable storage via a re-runnable importer; model access always goes
  through the gateway over loopback. Routines are deferred (unused today).
  Design: `docs/specs/2026-10-04-ts-server-pi-durable-design.md`; milestones:
  `docs/plans/2026-10-04-ts-server-pi-durable-plan.md`. Work branch:
  `agent-plane` (worktree `~/guild-wt-agent-plane`).
- **Prod is a separate checkout** (`~/guild-live`, branch master, compose
  stack on :18081, public at guild.example.org). Deploy to prod by
  fast-forwarding its master from ~/guild's develop (fetch the local path,
  merge --ff-only — its docker-compose.yml carries prod-local edits, so
  never rebase it) and `docker compose build server && up -d` there. First
  multi-workspace deploy: 0.5.32 on 2026-09-30. The 0.5.22→0.5.32 jump
  exposed that an untracked migration file breaks the tree — migrations
  must be committed with their store/mod.rs entries.

- **Multi-workspace auth — the daemon holds N live sessions, one per
  server.** The desktop client can now be signed into two guild servers
  (different domains) at once and switch between them: both servers see the
  machine online and either can dispatch tools. Design spec:
  `docs/plans/2026-09-30-multi-workspace-auth-design.md` (approved:
  "both live simultaneously", not Slack-style single-active switching).
  Mechanics: `workspaces.json` (session list + active pointer) beside
  `token.json`, which stays the ACTIVE session's mirror so the watcher,
  CLI logins, and every reader keep working. The single machine-link
  channel became a registry (one link task per live workspace, supervisor
  per host cycle). New RPC: `workspace.list`, `workspace.switch`;
  `session.clear` gained an optional `base_url` (per-workspace sign-out).
  Webview: workspace switcher in the account menu, "Add workspace" shows
  the pair/sign-in card over the running app; switching re-mirrors
  `session.info` and reloads (the existing restore path). Accepted
  consequence: one machine's executor serves two servers concurrently —
  dispatches are independent requests, the executor processes them one at
  a time. Machine slots are per-server, so the 0.5.25 live-slot rule is
  unaffected. A dead token in one workspace keeps its row listed as "sign
  in again" instead of vanishing.

- **0.5.25 — a live machine slot is held, not displaced.** Root cause of the
  recurring devbox outages: any locally-run guild binary (dev sessions on
  this box — which IS devbox) loads the real token.json and connects a
  machine link as the same row; the hub's newest-wins displacement handed
  the slot to the thief, and the displaced link never learns it lost the
  slot — its leftover server conn keeps heartbeating, so the daemon sits
  "connected" while the machine shows offline until the daemon restarts.
  The hub now REJECTS a connect from a different instance while a live slot
  exists (same-instance reconnects still replace their own zombie slot —
  that's the blip-heal path); clients of every deployed version already
  park 300s on the Displaced notice and retry. Rejections are logged with
  machine + instance. Known limit: instance_id is client-claimed, so a
  determined spoofer could still bypass — real defense would need
  per-instance credentials. Server-only change; no client release needed.

- **0.5.24 — the Windows machines were offline because of one misplaced
  flag.** WORKSTATION's daemon trace (the 0.5.23 toggle earning its keep) showed
  `daemon host cycle failed: os error 87` once per second: the Sep 23 pipe
  rewrite passed `PIPE_REJECT_REMOTE_CLIENTS` in `dwOpenMode` where the bit
  is unassigned, so `CreateNamedPipeW` failed on every call and the host
  cycle aborted + respawned the machine link once a second — no Windows
  client could hold a link past ~1s (WORKSTATION, DEVBOX-2), while the
  Linux daemon path never runs this code. Flag moved to `dwPipeMode`; the
  reclaiming host also no longer tears the link down on a failed bind (the
  link is independent of the CLI socket — the Sep 23 abort+respawn shape
  was the storm's other half). Lesson that keeps paying: the Sep 25
  instrumentation + the 0.5.23 trace toggle turned "why is it offline"
  into a one-line answer without touching the user's machine.

## Latest decisions

- **0.5.23 — daemon trace behind a settings toggle (WORKSTATION offline hunt).**
  WORKSTATION's machine link connects and the client closes it ~3 ms later
  (server telemetry: `reader_closed`, zero frames), then no retry for
  minutes — the retired-socket-host path, not the 1 s backoff. Same
  signature as DEVBOX-2's flap; Linux daemon links live. The client
  trace that names the end reason was env-gated only, which is useless on
  a user machine. dtrace now has a runtime gate (`dtrace::set_enabled`),
  the desktop app persists the choice (`daemon-trace.enabled` marker in the
  guild config dir, seeded at launch) and exposes it in Settings → About
  with the trace file path shown. The env var still works for headless
  daemons. Trace file now size-capped (1 MiB, same as the IPC trace).

## Where things stand

- **Server** runs on :18080 (compose, embedded web bundles). It carries the
  0.5.19 feature set plus six full review rounds merged on 2026-09-24
  (126 findings fixed across auth/session, machines/executor identity, turn
  queue, provider contracts, engine session lifecycle, integrations, and
  desktop transport). Live-bundle and migration state verified per deploy.
- **Clients:** desktop 0.5.22 released 2026-09-26 (all four platforms,
- **Telemetry (opt-in):** the server proxies `POST /faro/collect` to the
  shared Faro collector (Alloy+Loki in `/srv/faro`, `GUILD_FARO_URL`); the
  client ships a Settings → About toggle (off by default, localStorage
  `guild.faro.enabled`) that lazy-loads `@grafana/faro-web-sdk` and sends
  app diagnostics through the paired server. Collector receives app_name
  `guild`; logs land in Loki (`/srv/faro`), traces forward to Laminar.
  installers + updater bundles, sha256-verified, updater manifest serving it
  with minisign signatures). 0.5.22 ships the mobile-chat fixes: the
  project-chat send crash (uncaught render error bricked the view — analysis
  and repro in docs/plans/2026-09-24-mobile-chat-ux.md), chat error boundary,
  icon-only composer badges on narrow screens, touch-drag containment
  (pull-to-refresh no longer pans the shell), top-center toasts on phones.
  0.5.21 (2026-09-25) shipped the CSP removal — avatars render in desktop
  and web clients. Running clients pick releases up via the auto-updater on
  relaunch; the devbox install (0.5.18) must be relaunched (or updated in
  place) to reconnect — 0.5.18 cannot talk to the current server. Client
  releases remain dev-controlled and deliberate.
- **Quality baseline:** six review rounds with adversarial verification; the
  last two fix-diff audits found no regressions. Full gates at merge time:
  workspace cargo test (705+ tests), frontend vitest, strict clippy,
  windows-gnu check (`scripts/check-windows.sh`), bindings freshness.

## Next steps (ordered)

1. **Ship desktop 0.5.20 to the devbox install — blocking, user-visible.**
   The release is published and verified; the devbox install (0.5.18) needs a
   relaunch so its auto-updater takes 0.5.20, then confirm the machine link
   establishes against the current server.
2. **Confirm-or-reopen two legacy items** (their original context predates
   the review loop):
   - Thread list + thread messages keyset pagination/infinite scroll —
     `list_events_page` may already exist in a prior working tree; check and
     finish or re-plan.
   - Machine-link flap diagnosis (0.5.17-era) — later rounds reworked the
     watchdog/error-frame handling; likely improved but never confirmed
     against a flapping client. Re-open only if a client still flaps.
3. **Fix the flaky reaper test** `the_reclaiming_daemon_entry_reaps_completed_agent_tasks`
   (fixed 12 s sleep racing a 10 s cadence; failed under load three times
   during verification).
4. **Optional client hardening after the 0.5.20 rollout:** confirm the updater
   pending-update fix behaves on a real install (it was logic-verified only —
   Tauri updater APIs need an app bundle to test).

## Future directions

- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `docs/reviews/2026-09-24-loop-summary.md` for the per-surface pass counts
  and the process playbook (mixed reviewers; pi fixer/verifier; verifier
  rebuilds exploit chains against the real caller; env var gotcha:
  `GUILD_TEST_PG_URL` is a base URL without a db suffix).
- **Review coverage gaps to close in that loop:** Windows-only engine paths
  (compile-checked, never executed), desktop updater flows (logic-verified
  only), integrations connectors (one sweep), and the accepted residuals
  listed in the round FIX/VERIFY reports (per-frame usage billing,
  process-crash usage loss, html_csp parser latent note).
- **Engine/product direction unchanged:** one agent loop, thin desktop
  backend, project-derived executor binding, durable Restate workflows. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.

## Working conventions

- **Always redeploy after a change** — detached compose build+up from
  `deploy/compose`, then verify the live bundle hash and API health. The
  user tests against :18080.
- **Sessions run this repo concurrently** — check `git log`/`git status`
  before and after editing; pull rather than clobber.
- **Review-loop branch topology:** `review/roundN-<agent>`, `fix/roundN`,
  `verify/roundN` worktrees under `~/guild-wt/`, merged `--no-ff`, branches
  and worktrees retired after merge; orchestrator prompt/report files stay
  out of the repo root (reports live under `docs/reviews/`).
- Comments describe what code IS and does now — no history narration. Docs
  like this file carry the story.
