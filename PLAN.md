# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a Rust workspace (cloud
server, local engine, shared protocol/core crates) plus a Tauri desktop
client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. History is
not kept here — it lives in git and in `docs/reviews/`.

Updated 2026-09-28.

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
