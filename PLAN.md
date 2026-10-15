# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a Rust workspace (cloud
server, local engine, shared protocol/core crates) plus a Tauri desktop
client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. History is
not kept here — it lives in git.

## Latest decisions

- **Machine-dispatch IPC proxy shipped (`a94047b`) + dev worker soak
  started (2026-10-15).** Machine-bound chats — the user's primary
  surface — now serve in worker mode: the worker's ExecutionEnv proxies
  tool dispatch to the server's hub over the fork channel, so the hub
  stays the only machine-connection owner. Dev runs
  `GUILD_WORKER_MODE=on` (a live turn completed through a forked worker);
  prod stays supervisor-mode until the soak is clean. Remaining M2.5:
  idle reap, live approval/compaction/steering verification, prod flip.

- **Release 0.5.47 shipped (2026-10-15).** The thread-domain rename rode
  it end to end: server routes (`1622f35`), desktop transport (`8882a68`,
  `/api/v1/threads` + `/api/v1/models`, chat id on the path), version
  bump `2ace1c6`, master sync `5f4676a`; all six artifacts published
  against prod and the updater manifest serves them (auto-update picks
  them up within 15 min of client launch). Wire FIELD renames
  (`chat_id` → `thread_id`) are the next release's coupling decision.

- **Thread-domain rename: /api/v1/threads is primary — shipped in 0.5.47
  (2026-10-15).** The user asked for the full chats → threads rename, staged
  by release coupling: (1) server routes (`1622f35`) — every thread surface
  lives at `/api/v1/threads/*` (CRUD, submit with the chat id on the path,
  stop/compact/approvals/pending/read/project/events/stream) with every
  `/api/v1/chats…` and `/api/v1/gateway/chat…` path a deprecated alias on
  the same handler, marked in code; (2) the desktop transport (`8882a68`)
  speaks only the new paths + `/api/v1/models` — shipped desktop-first only
  because the server aliases went live first; (3) after this release lands
  on clients: wire FIELD renames (`chat_id` → `thread_id` in payloads, ws
  frames, `{chats:[]}` → `{threads:[]}`) both-sides in one release; (4)
  internal renames (DB tables, stores, Rust protocol, desktop state) have
  no wire impact and can trickle. "Gateway" vocabulary now means only the
  OpenAI/Anthropic API-gateway surface (`/openai/v1`, `/anthropic/v1`).
  Desktop 0.5.47 published against prod; aliases retire only after all
  clients are on ≥0.5.47.

- **Chat isolation: worker-per-chat with IPC — building (decided 2026-10-15).**
  Same incidents as above; the user decided worker-per-chat is the goal
  ("should be more scalable"), not gated on upstream. Plan:
  `docs/plans/2026-10-15-chat-isolation-plan.md`. Shipped so far: M0
  supervisor (`fe67fd8` — in-process `harness.closed` → reopen with backoff),
  the scoped-echo UUID fix (`9ee39b5`), and `ScopedDurableStorage` (`2fe2d57`)
  with the double-drive proof: a harness over a scoped storage cannot adopt
  another conversation's pending task. Architecture: the main server drops
  its harness entirely (no second scheduler); admission moves into workers
  via IPC with `requestId` dedupe; frames need no IPC (the bridge's
  thread_events + pg_notify path already crosses process boundaries);
  spawn on first admission or pending-work-at-boot. **M2 shipped**
  (`b314458`, flag-gated `GUILD_WORKER_MODE=on`): fork supervisor, worker
  entry, IPC routing for admission/control, journal-driven boot recovery +
  respawn; `mintId` made cross-process-atomic (in-memory watermark reused
  ids across harnesses); SIGKILL-isolation gate green; suite at baseline.
  M2.5 remains: idle reap, approval/compaction live verification, machine
  dispatch IPC proxy, then flip the flag on dev → prod.
- **The storage layer survives transient Postgres failures instead of sealing the session (2026-10-15).**
  Root cause of the chat wedge (incident 2026-10-15): pi-durable is fail-stop by design —
  "nothing retries, that is the Storage's to retry" — and the Postgres adapter never retried,
  so one transient blip sealed every Session in the process until the next deploy restart.
  Fixes: `PgPoolDatabase` retries connection-class failures on plain reads/read transactions
  and bounds every write transaction server-side (`SET LOCAL` idle-in-transaction + statement
  timeouts) with a client watchdog that destroys a stalled socket (a hung commit can no longer
  hold the `durable_metadata` row lock). `PostgresDurableStorage.commit` retries through
  transient failures and adopts an already-applied batch via a `durable_commits` row
  (migration v3) keyed by the batch's full ID-set fingerprint — adoption arms only after the
  call saw a transient failure, because the conformance contract demands a clean ID-claim
  conflict reject immediately (first-ID keying falsely adopted foreign batches). Also: an
  empty route read no longer wipes the org's live model catalog mid-turn (`ensureOrgModel`
  guard — the `no_model` trigger); turn commands whose delivery threw are marked failed and
  stale `pending` commands are swept at startup and per-submit (the wedge left two immortal
  pending rows); the `conversationForChat` reset logs loudly (thread replay deferred).
  `docs/SRS.md` SRS-46 carries the always-allow piece of the same day.

- **Full durability: deploys resume turns instead of ending them (2026-10-15).**
  The SIGTERM drain (below) is gone. A deploy's shutdown now hard-exits
  (`process.exit` on SIGTERM/SIGINT, no graceful close): pi-durable's graceful
  close turned out to be what destroyed resumability — its abort signal kills
  the in-flight model call, the generation runner classifies that as a
  retryable error, re-drives against its own dead signal with backoff, and
  settles the task failed (measured: 5.9s of close, task terminal, run lost).
  A hard stop leaves the journal consistent (commits are atomic) and the run
  pending, and the next process resumes it. Three gaps closed so a resumed run
  actually completes: watches attach before `harness.resume()` (attached
  after, the attach snapshot is not delivered as `run_start`, so the bridge
  misses the generation id and the turn-command claims); org model providers
  register at startup (`refreshAllOrgModels`) — submit-time refresh alone
  meant a resumed run failed `no_model`; the shutdown handler no longer calls
  the drain. Proven by a new restart-resume test: a turn killed mid-stream
  (connections destroyed, storage unreachable) resumes in a fresh process and
  completes. Also in passing: the 13:27 poisoning incident (the `pi.live`
  document of conversation 5206 took delta ops it could no longer
  materialize — `unresolvable path: ["generation","message","content",0]` —
  and every new session died on it at watch attach, `SessionFailed` for all
  chats) was repaired by deleting the one poisoned ephemeral document;
  `scripts/durable-repair.mjs` scans for and removes such documents
  (`--fix`). Found via the user's screencast of a thread that accepted two
  messages and never answered.
- **`always_allow` tool curation — the org grants a tool past the approval gate (2026-10-15).**
  The per-tool admin curation on an integration row gains a third approval
  value next to `default` and `always_ask`: `always_allow` classifies the
  tool as `skip` in the gate — the call flows with no approval card
  regardless of the chat's approval mode or the chat owner's account
  policy, the mirror of `always_ask` forcing the card over them (org
  governance wins in both directions). Read-class tools (web_search,
  web_fetch, scrape/search/map) already flow by default — this is for
  write/admin-class tools the org deems non-sensitive, and it makes the
  intent explicit instead of relying on the class floor. Admin API
  validates and echoes the value; the admin UI's Tools table gains the
  "Always allow" option; the script API needs no change (only always_ask
  is refused there, as non-interactive). SRS-46 updated. Tests: m6 covers
  the admin curate/read-back round trip, m8-chat proves a write-class
  always_allow tool (`slack_post_message`) executes with no card where the
  default curation would have gone to the judge/card. Full suite: 439
  passing, failures identical to base (pre-existing timing flakes + the
  stale golden). Commit `6612a4b`.
- **Chat view modes — casual/technical, header kebab, hover timestamps (2026-10-15).**
  Designed by grill (doc: `docs/plans/2026-10-15-chat-view-modes-design.md`). The
  thread header gains a kebab menu: Rename (popup dialog), Archive/Unarchive
  (archiving the open chat navigates to the chats list), a divider, and the view
  picker. The mode persists per user server-side: `user_kv` (migration 0071,
  user-scoped mirror of org_kv) + `GET/PUT /api/v1/me/settings` with
  `{ chat_view }`; absent = default **casual**. Casual view only affects
  thinking/tool blocks: each contiguous run collapses into one
  "Agent is working Ns" (pulsing, counts up) → "Agent worked for S seconds"
  entry (casual-only, extra padding around it, absent on pure-text turns);
  pending approvals stay, compaction cards hide, terminal turn errors show bare
  ("Turn failed"), tool errors hide. Hover timestamps: user/agent-text messages
  (both views) carry an always-mounted, opacity-hidden, absolutely positioned
  strip below the message (zero reflow); locale-aware — time only today, +
  month/day within the year, + year older. Reducer now stamps durable text
  blocks with `ts` (tool/reasoning already carried it). In technical view the
  rendering is byte-identical to before.
- **Release 0.5.46 (2026-10-15).** First release cut straight from develop's
  working tree: the approval-gate idempotency fixes (below), the agent
  sessions' queued mid-turn sends (steer/queue chips, withdrawal), the
  sidebar's recent-activity sort (+ the `(chat_id, seq)` index migration),
  the eventless-chat fix in the thread-list probe, and the pending-send
  adoption fix (the durable echo now clears the optimistic marker).
  develop → master `--no-ff`; servers rebuilt on both stacks (:18080,
  :18081); client artifacts published to both deployments with their URLs
  baked; both updater manifests serve 0.5.46.

- **Approval gate survives recovery re-runs; cards stop dying mid-wait (2026-10-15).**
  The gate is recoverable (pi-durable re-drives suspended tool tasks), but its
  card re-append was not idempotent: the deterministic request id met a
  payload that always differs (the judge verdict rides the card, including
  its wall-clock `ms`), the old `ON CONFLICT … WHERE payload =` guard skipped
  the row, `appendEvent` threw, and pi-durable settled the call as
  "Tool call blocked: thread event append returned no row" — while the user
  still saw the pending card, which then resolved as "aborted before
  decision". Observed live: three chats' gates re-driven in the same
  millisecond, five consecutive 5-minute auto-denies as the model retried
  each denied call. Fixes: `appendEvent` re-appends are first-writer-wins
  (conflict returns the existing row, never throws); a gate re-run reuses
  the shown card's judge verdict instead of re-judging; the judge timeout
  drops 30s → 10s (a stalled judge must not hold the card — it shares the
  local model pool with the user's own streaming turn); the timeout block
  text now forbids retrying the call (the old "denied by user: timed out"
  invited the retry loop). Card delivery itself measured fine: journal row →
  ws client in ~5ms. Also fixed in passing: the sidebar's latest-activity
  probe in `feed.ts` used `CROSS JOIN LATERAL`, dropping event-less chats
  (machine-presence flip never reached the browser for a fresh chat).

- **LLM observability is live: every model + judge call traces into ClickHouse (2026-10-15).**
  Two TS-owned tables (idempotent DDL on the trace sink's first use, TTL-managed):
  `guild.llm_calls` — one row per LLM call with caller/cause/verdict metadata
  (90-day TTL) — and `guild.llm_payloads` — request/response bodies, opt-in via
  `GUILD_TRACE_PAYLOADS=1` (dev only for now; 14-day TTL). Contract: the gateway
  inserts `caller='model'` rows and skips everything trace-shaped for requests
  carrying `x-guild-internal-caller`; the approval judge self-reports
  `caller='judge'` rows with `cause=approval-gate:<tool>:<call_id>`, the verdict,
  and the chat owner as user id. One request id spans `usage_events`,
  `llm_calls`, and `llm_payloads` (the judge pins its own via
  `x-guild-request-id`, so its trace row joins the usage row the gateway
  metered). In-app turn context (chat/conversation/turn + owner user id) rides
  request headers through the loopback provider — a per-org slot set by
  `submitTurn`, best effort: two same-org turns in flight overlap on it, and
  the latest turn's context wins (judge rows are exact; client/machine lanes
  can set the same headers where they know the context). Attribution side
  effect: internal model calls now carry the real chat owner as
  `usage_events.user_id` (previously the synthetic internal-caller uuid) —
  per-user usage breakdowns become truthful, org quota math unchanged.
  Known gap: judge trace rows carry `reasoning_tokens = 0` — the gateway's
  non-stream usage body does not include `completion_tokens_details` (the
  summary joins cost from `usage_events` instead, so judge cost is right).
  API: admin `/api/v1/admin/observability/{calls,summary}` + per-row payloads
  (admin only); member `/api/v1/observability/{calls,summary}` force-scoped to
  the session user — no org id is ever trusted from the client. UI: settings →
  Observability (visible to everyone; admins see the org, members themselves)
  at `/settings/observability` with the open row at
  `/settings/observability/<request_id>` and period/caller/model/chat filters
  in the URL query; explicit empty state distinguishes "no calls recorded"
  from "ClickHouse unreachable". Payload duplication trap (fixed): the gateway
  must not capture payloads for internal-caller requests — the judge
  self-reports its own. Verified on the dev stack (:18080, `GUILD_TRACE_PAYLOADS=1`):
  three turns with gated `hubspot_api` calls produced model rows (chat/turn/
  owner attributed, cause `turn-step`) and judge rows (verdict=true,
  cause carrying the tool call id); admin API + summary + payloads verified;
  UI smoke passed (deep link, filters, row drawer with payloads). Tests:
  `apps/server/src/test/trace.test.ts` (sink DDL + round-trip, gateway
  emission + internal-caller skip, judge self-report, member scoping),
  `apps/desktop/src/views/settings/sections/observability.pure.test.ts`
  (URL contract). Pre-existing failure not touched by this work:
  `platform/golden.test.ts` fails on the base commit too (stale `/me` golden
  missing the `onboarded` field).
- **Server runtime is Bun — no server compile, no dist (2026-10-14).**
  `Dockerfile.server-ts` no longer runs tsc for the server: the runtime
  stage installs Bun (copied from oven/bun:1 into the node:22-slim base,
  so node stays available) and executes `apps/server/src` directly
  (`bun src/index.ts`); the sandbox-runner service runs
  `bun src/sandbox/runner/main.ts` the same way. The only compile left in
  the server image is the generated protocol bindings (their .js/.d.ts
  siblings are what make @guild/protocol imports resolvable at all — Bun
  does not substitute extensions through bare package exports either,
  measured 2026-10-14). Local scripts: `start` → bun, `dev` stays tsx,
  `typecheck` stays tsc (fed by check-bindings.sh's compile). The sandbox
  agent keeps running node inside the separate guild-sandbox image —
  untouched. Schema-first IDL (protobuf) for the protocol remains the
  longer-term direction (see Future directions).
- **Bindings compile in place; @guild/protocol exports an identity map
  (2026-10-14).** The NodeNext-consuming server could not actually resolve
  `@guild/protocol/ThreadEvent.js`: the .js→.ts substitution only applies to
  relative imports, never bare package subpaths through node_modules. The
  package now exports an identity map (`"./*": "./*"` — the import subpath
  already carries the .js suffix; a `./*.js` target would double it).
  `check-bindings.sh` and the image build compile the generated .ts in place
  (sibling .js + .d.ts, gitignored; sources stay the single source of
  truth): tsc resolves types through the .d.ts siblings, node at runtime
  through the real .js. The image's runtime stage copies the bindings
  package (node_modules/@guild/protocol is a symlink into it). Desktop is
  unaffected (extensionless relative imports via vite).

- **Type single-sourcing: hub consumes generated protocol bindings; registry
  manifest moved into protocol (2026-10-14).** The hub hand-mirrored Rust
  protocol types in three places and the mirrors had drifted (the TS
  ToolSpec was missing the `kind` field). Now: `apps/server` imports the
  generated `crates/protocol/bindings/*.ts` directly — bindings are an npm
  workspace package (`@guild/protocol`, `crates/protocol/bindings
  /package.json`), and the freshness gate (`scripts/check-bindings.sh`)
  normalizes ts-rs's extensionless imports to NodeNext `.js` specifiers so
  NodeNext tsc resolves them (bundler-mode desktop is unaffected).
  Swapped: provider message types (InternalMessage = generated Message;
  builders omit optional fields instead of writing nulls — serde defaults
  accept both) and the thread-event model (domain/thread-events.ts re-
  exports generated ThreadEvent/Block/MessageAttachment/UsagePayload;
  ThreadEventRow stays local). 64-bit wire fields got `ts(type =
  "number")` (bigint on a JSON wire throws in JSON.stringify). The
  registry manifest model (BundleManifest + section types + validate
  manifest/validate_v2/tool_class) moved verbatim into
  `protocol/src/registry.rs` and generates 7 new bindings; guild-core
  keeps the tar.gz codec and re-exports the model; registry-manifest.ts
  re-exports the binding and keeps its deliberately-loose `Manifest` as
  the untrusted-input validator shape. Also in this pass: guild-core's
  dead Rust provider clients and usage sink deleted (the TS durable
  harness drives the loop), 12 orphaned workspace deps dropped, stale
  pipe_probe examples removed, docs/reviews deleted (history lives in
  git), all `--all-targets` warnings fixed. The protobuf question was
  considered and declined: the wire is JSON end-to-end (browser clients,
  persisted journals, wiremock fixtures) and the duplication was ~300
  lines — the binding package solves it without a wire-format migration.
- **Release 0.5.44 (2026-10-14).** First release through the reconciled
  flow: develop → master `--no-ff` (f347971) carried the sandbox-runner
  (gVisor), URL-driven navigation, the onboarding guide, webchat
  first-send/coalescing/turn_error fixes, JetBrains Mono, and the skills
  markdown viewer; version bumped everywhere to 0.5.44
  (`scripts/bump-version.sh`), client artifacts published to both
  deployments with their URLs baked (dev → guild.example.com :18080, prod →
  guild.example.org :18081), servers rebuilt on both stacks.

- **Branch reconciliation: master merged into develop, develop merged back (2026-10-14).**
  The 0.5.43 hotfixes went master → cherry-pick → develop, leaving the branches
  forked at different SHAs. Resolved by merging master into develop (PLAN.md got
  the read-mark + prod-cutover entries in chronological order; bridge.ts and the
  tests took develop's superset — the coalescing fix plus the HTTP-parity test)
  and then `--no-ff` merging develop back into master, so both branches share
  history again. Lesson recorded: hotfix on master, but land it via the
  develop → master release merge next time — cherry-picks fork the graph.

- **GET /api/v1/chats is hub-coupled (2026-10-14).** The M3-era
  `machine_online = false` hardcode in `chatWire` survived the M5 hub
  cutover: the HTTP thread list (and the single-chat CRUD responses) always
  reported the bound machine offline while the ws push
  (threadListSnapshot) and GET /api/v1/machines told the truth. The
  webchat's offline banner keys off the HTTP row, the sidebar pin off the
  machines list — an always-online machine never triggers a
  presence-change push, so the banner stayed "X is offline" under a green
  pin indefinitely. The HTTP surfaces now compute the flag via
  `machineOnlineOf` (the same hub truth); regression test in
  ws-feed.test.ts pins HTTP/push/machines parity.
- **Trailing reasoning no longer splits the live answer (2026-10-14).**
  Backends that emit a reasoning delta after the answer began (local vLLM,
  DeepSeek-class models) streamed as [thinking][text][thinking][text] — the
  live frames relay arrival order while the durable assistant message
  flattens into one reasoning + one text block, so the live view and the
  replay disagreed mid-sentence. Same root cause as paseo#2803 and
  svkozak/pi-acp#96. Fix in the bridge (one producer of live frames): once
  answer text streams for the current assistant message, thinking deltas
  stop being emitted live and only accumulate into the view buffer — the
  tail joins the reasoning block at the turn-boundary restamp, matching the
  durable form with no added latency.
- **Silent turn deaths now surface + shutdown drains (2026-10-14).** A turn
  whose generation task fails (model unreachable, deploy restart mid-turn)
  used to vanish: the failure rode only a live error frame — no persisted
  event, so a reload or lost socket left the thread with no answer and no
  error. Now the bridge persists a `turn_error` thread event on
  `task_failed` (new ThreadEvent variant, protocol + bindings + reducer;
  renders as the existing destructive error card, "Turn failed: …"), and
  SIGTERM drains first: `runtime.drainChats()` aborts every generating chat
  while sockets are alive (tasks settle, generating flips, terminal frames
  reach clients) before the listener closes, with a 5s grace before
  `app.close()`. Found via the 01a13a57 thread: approvals ran, tools
  executed, then the model calls died with instant loopback connection
  errors during a concurrent deploy churn.

- **First send: hold the screen, land straight on working (2026-10-14).**
  Refines the pending-submit design above after a new screencast: the two
  intermediate states (emptied composer on the scratch surface, then the
  thread skeleton) are gone. The scratch composer now HOLDS during the
  create — sent text stays visible, input is blocked (`readOnly`, keeps
  focus), the send button shows the pending spinner — and the detach only
  clears the persisted draft, not the visible composer. When createChat
  responds, `created()` seeds the created chat's reducer view with the
  optimistic send and carries busy across the route push
  (`justCreatedBusyRef`: the chatId effect skips its busy reset once), so
  navigation lands directly on the working thread — user message plus
  WorkingIndicator — and the first server thread state takes over from
  there. A failed create/submit still falls into the retry card with the
  text already in the composer.

- **One onboarding guide over the running UI (2026-10-14).** The separate
  help popup is gone — the rail's Help/Learn button opens the onboarding
  guide itself: a big dialog floating over the live app (not a blank
  full-screen takeover), selected topic on the left, switchable section list
  on the right (Welcome, Desktop app, Connect other tools, Chatting,
  Projects). One address, `/onboard`, chat-independent top-level; /help deep
  links parse onto it and chatRoutePath never emits /help. Auto-push for
  not-yet-onboarded users stays (`users.onboarded_at`, migration 0069;
  `onboarded` in login/me; `PUT /api/v1/me/onboarded` marks it — the guide
  owns the URL on reload). Closing from any section (Got it / skip / Esc /
  ✕) marks the flag and navigates to /chats — /onboard itself always renders
  the guide. The desktop/gateway section buttons still jump to the device
  dialog / /settings/gateway after marking the flag. Desktop skips the
  auto-show (its own pair/sign-in flow) but /onboard works there too. Copy:
  plain-language, non-technical — "Guild is your private AI workspace".

- **First send renders no optimistic bubble — pending submit until the chat exists (2026-10-14).**
  The scratch-view optimistic send (bubble in the LOOSE view, adopted by the
  created chat via `skipLoadRef`) is gone: a first send now clears the
  composer into a durable command and holds a pending-submit spinner on the
  send button (state `pendingSubmitId`, precedence stopping > Stop >
  pending > send in `sendButtonState`) while create/prepare/send are in
  flight; nothing renders optimistically because there is nothing to render
  into. When `createChat` responds the route moves once and the thread shows
  a skeleton until the first server thread state (user message + turn)
  lands — the render is pure server truth. The reducer's `adopt`/`bindPending`
  stay for the reducer API but no first-send caller remains; sends from
  existing chats keep their optimistic bubble. `busyAfterThreadPush` no
  longer busies the null-chat composer off an in-flight first send, and
  `sendingRef` is scoped to the open chat (set in `created()`), so a
  background send can't busy an unrelated open chat. Also fixed en route:
  the previous commit's adopt-branch busy no longer applies (branch
  deleted).

- **First-send submit: no dead window, no duplicated stream render (2026-10-14).**
  Two bugs behind the flicker a first-send screencast showed. (1) The
  chatId effect's unconditional `setBusy(false)` wiped the optimistic busy
  the moment the created chat's route landed, so nothing indicated work —
  no Working shimmer, no stop button — between route adoption and the
  server's first `generating=true` frame (~1s); the adopt branch now keeps
  the busy (the submit is still in flight there by construction). (2)
  Stream frames key reasoning blocks per-stream (`live-N` whenever a
  thinking delta opens after a text tail); the commit's buffer strip
  removed only the two sentinel keys, so those orphans kept rendering
  above the durable copies — the response appeared twice. The strip is now
  by key prefix (`live-`/`unpersisted-`). Regression test in
  thread-reducer.test.ts.

- **Server-side tools run in gVisor sandboxes via a sandbox-runner (2026-10-14, branch `sandbox-runner`).**
  Server file/shell tools ran in the Fastify process, unconfined
  (`NodeExecutionEnv` takes absolute paths as-is: a full-access chat could
  read the master key from `/proc/self/environ`). Now: one `runsc`
  container per workspace session / plain chat, mounting only its
  `guild_data` subpath, non-root, read-only rootfs, no secrets; created by
  the `sandbox-runner` service, which alone holds the Docker socket and
  fixes the container spec. An in-sandbox agent wraps
  `NodeExecutionEnv{cwd:/workspace}`, reached over the exec stdio stream
  (`apps/server/src/sandbox/`). Network: an internal network whose only
  exit is a squid egress proxy (registry allowlist, private/host
  addresses denied) — addressed by IP, since Docker's embedded DNS fails
  under gVisor. Package installs persist in `/workspace/.sandbox-home`.
  Server runs as uid 1000; `GUILD_SANDBOX` fails closed in production;
  shell tools default on with a runner. Also fixed on the way: skill slug
  traversal, and NUL bytes in tool output breaking thread journaling.
  Host: gVisor 20261005.0 on devbox. Single-host compose only; Kubernetes
  deferred. Plan + decisions: `docs/plans/2026-10-14-sandbox-runner-gvisor.md`;
  deploy notes: `docs/deploy-nuances.md` §4a.

- **Settings + new-chat navigation are URL-driven (2026-10-14).** The
  principle landed with its gaps closed. *Settings*: every section pick
  navigates to `/settings/<section>` and every sub-page to
  `/settings/<section>/<detail>` (`openSettingsSection`/`openSettingsDetail`
  go through pushRoute; the pane-state section is gone — the route is the
  only source, so back/forward walks sections and a reload restores the
  pick). A bare `/settings` normalizes to `/settings/account` via
  replaceState; tab picks land on the current-or-default section. The
  device-dialog detour keeps the section in memory (its URL still goes
  through /chats). *New chats*: the scratch composer is addressed —
  `/chats/new`, `/work/new`, `/project/<id>/new` (the reserved `new`
  segment, skills-route style) — and the project pre-pick is route state
  (the pick effect derives it from the URL, no more scratchPickRef),
  upgrading to `/project/<id>/thread/<cid>` on first send. `tab` roots stay
  bare; `newChat` drops on any chat/overlay/skills/settings navigation.
  `pickAfterChatSwitch` removed (route replaces it). Review:
  `2026-10-14-url-navigation-review.md` (git history).

- **All navigation state is URL-driven (principle, 2026-10-14).** Recorded
  in AGENTS.md conventions: every reachable page/tab/panel/sub-page has its
  own fixed URL; navigation never changes local state without a history
  entry. Review of the current gaps (settings section + detail navigation,
  new-chat addresses `/chats/new`, `/work/new`, `/project/<id>/new`) is in
  `2026-10-14-url-navigation-review.md` (git history).

- **Prod releases move to a branch flow (2026-10-14).** A `prod` branch now
  tracks the deployed release: each release is a `--no-ff` merge of develop
  into prod (release commit: `daff203`, 0.5.42), `~/guild-live` deploys from
  it (detached HEAD at the merge commit — the branch name is taken by the
  main checkout), and the merge is also merged back into develop so the
  branches never diverge. The first merge surfaced real master-side fixes
  develop had lost: `release-clients.sh` requires `VITE_DEFAULT_SERVER_URL`
  (the deployment's public URL bakes into the client bundle — releases built
  without it default fresh installs to localhost:18080), the prod-deploy
  README, and the per-deployment release checklist in deploy-nuances.md.
  0.5.42 artifacts were re-published to both deployments with the URL baked
  (dev → guild.example.com, prod → guild.example.org); sessions used for
  the publish API were throwaway Postgres rows, deleted after.

- **The member socket goes quiet mid-turn; the read-mark rides the duplex (2026-10-14).**
  Two streaming-path corrections. *Views publish only at turn boundaries now*: the
  bridge no longer dirties the feed on streamed deltas (`message_start` partial /
  `message_update`), and `committed()` skips the view publish while the chat's
  generation is open — the `generating=false` flip dirties the chat exactly once,
  and the 100ms poll broadcasts the turn's single final `thread_state`. Each frame
  carries the full event history, so per-delta publishes re-broadcast the whole
  thread per chunk (observed live: 165 `/read` POSTs + 1.4 MB transferred over one
  active turn). The client renders the in-turn stream from the cheap `live_frame`s
  through the reducer's dormant `applyFrame` (the wire contract "content is
  sequenced-ThreadState-only" holds — frames render deltas, the turn-end state
  reconciles). *The read-mark moved onto the socket*: a new client→server
  `WsClientMsg::Read { chat_id }` (protocol crate + TS parser mirror, bindings
  regenerated) writes the same `chat_reads` row the REST route did, on the duplex
  the frames already ride — the fetch-based `markChatRead` is gone, and the client
  fires it only when the applied view carries events newer than the last marked
  one (per-frame POSTing would otherwise have continued over the socket). Tests:
  parser cases (hub) + the duplex write (ws-feed); the pre-existing environmental
  `app.test` SPA-503 failure is unrelated (fails on a clean tree).

- **Prod cutover complete — the TS server serves :18081 (2026-10-14, 0.5.42).**
  The `guild-live` compose project runs `guild-server-ts:prod` (its own tag, set via
  `GUILD_TS_SERVER_IMAGE` in `deploy/compose/.env`), built from the deliberate
  develop → master merge. The Rust-era config debris is gone: `config.env` carries
  `GUILD_INTERNAL_KEY` now; `GUILD_ROLE`/`GUILD_INTERNAL_TOKEN`/`GUILD_RESTATE_*` and
  `.env`'s `GUILD_SERVER_IMAGE` are deleted. Restate retired with it: container
  `guild-live-restate-1` and volume `guild-live_restate_data` removed. Cutover
  sequence per `docs/plans/2026-10-04-ts-server-prod-cutover-runbook.md`: pre-backup
  `~/backups/guild_live-2026-10-14-1300.sql`; final importer run on the prod DB
  (`6 chats → 6 conversations, 145 events → 145 entries` — exact match; note the
  host-run importer needs `host.docker.internal` rewritten to `localhost`, the
  runbook's literal command fails with ENOTFOUND); `schema_history` was already
  current (0068), so startup migrations were no-ops. Both machines reconnected
  (WORKSTATION @ 0.5.42, guild-machine @ 0.5.34 — the latter is due a client update),
  zero error-level log lines at startup.

- **Skills: uninstall deletes the pin; machines pull their sync at connect (0.5.42, 2026-10-14).**
  Two gaps in the org-skills loop closed. *Uninstall*: the Skills panel's org-installs
  rows gain an Uninstall button, and the local-machine rows' existing Uninstall now goes
  server-first (`DELETE /api/v1/skills/:slug/install`) — the old desktop path deleted only
  the local folder, which the next sync re-installed — with a local-only fallback for dirs
  carrying provenance but no install record (a folder copied in from another machine), plus
  a best-effort immediate local removal so the panel doesn't wait for the fleet push.
  *Always-sync*: the machine now pulls its desired install list itself at every link connect
  (`GET /api/v1/skills/sync-payload`, a new user-authed route serving the same payload the
  change pushes use; Rust `pull_skills` runs the standard converge — download pinned
  bundles, sweep provenance-carrying dirs the list omits, never touch plain user dirs).
  This closes the case the connect push deliberately skipped: a zero-pin user's stale
  physical copies used to survive forever, because the empty converge frame was suppressed
  at connect (the WS golden replay pins the machine-connect frame stream byte-exactly, so
  the server still never pushes at connect — the pull is HTTP, invisible to that stream).
  The `skipWhenEmpty` option and the `wsSkillsSync` connect seam are removed; change
  triggers (install/pin/uninstall) keep pushing. Desktop client needs a rebuild/release to
  ship the pull (binary rebuilt locally).
- **User-owned MCP servers + the codemode tool (0.5.40, 2026-10-14).** Two
  branches merged (`user-mcp`, `codemode`), both built by subagents in their
  own worktrees and browser-E2E-verified live on :18080.
  *User MCP*: members add their own streamable-HTTP MCP servers in Settings
  → MCP servers (list/add dialog with live probe/detail with enable toggle
  and delete); the server stores name/url/headers (headers encrypted with
  the org master key, API returns masked previews only), migration 0068,
  CRUD+probe routes user-session-authed with an SSRF guard rejecting
  private/loopback IP literals unless `GUILD_MCP_ALLOW_PRIVATE=1` (set in
  the dev compose config.env — flip it off for stricter behavior; DNS names
  are never resolved, so `host.docker.internal` passes). At turn start the
  chat owner's enabled servers are discovered (`listTools`) and their tools
  declared as `mcp_<server>_<tool>`, executed server-side per call with
  headers re-decrypted at call time; an unreachable server degrades to a
  prompt-index diagnostic, never a failed turn.
  *Codemode*: pi-durable upgraded 1.0.1 → 1.2.0 (breaking changes absorbed:
  Postgres storage scan-order/error semantics per the conformance suite,
  `ToolExecutionResult.content` → `output`, tagged tool-task unions,
  ChatBridge ignoring the new event fields; wire contracts unchanged). Every
  conversation now carries the `codemode` tool (`createCodemodeExtension`):
  the model writes JavaScript that runs in a QuickJS sandbox and calls the
  conversation's tools as nested calls (`tools.read`, `tools.bash`, skills
  and MCP tools too) — only the script's output reaches the model. Nested
  calls run the full tool pipeline (validation, hooks, exec policy, approval
  gate) exactly like direct calls. E2E: MCP probe + real-model turn
  (`mcp_e2efixture_add(2,3)` → `5`), codemode write→read script round-trip
  plus a correctly policy-blocked nested bash; SSRF deny path verified live.
- **Descriptions are one line, stored and rendered (2026-10-14).** The
  detail page's apparent line breaks were the `max-w-[560px]` render cap
  wrapping — the stored value was already single-line. Save points now
  collapse whitespace regardless: `singleLineDescription` (new, in
  `registry-manifest.ts`) normalizes the editor create/edit/fork fields
  and the push_skill derivation, and the desktop `parseFrontmatter` folds
  literal block scalars flat too — descriptions feed one-line index
  entries and a multi-line value would corrupt that format.
- **Publish parses the SKILL.md description; publish auto-installs (2026-10-14).**
  `descriptionFromSkillMd` (server push path) now reads the frontmatter's
  `description` first — single-line plain/quoted, block scalars (`>`/`|`
  with chomping indicators, folded with spaces vs kept newlines), and a
  bare key with indented continuation lines — falling back to the old
  first-body-line heuristic (which had grabbed the opening `---` fence as
  the description). Desktop `parseFrontmatter` (composer local-skill
  descriptions) reads block scalars the same way. Publishing auto-installs
  for the publisher in all three paths (editor create, fork, edit; agent
  push_skill): the same install record + `skill.installed` event + machine
  sync a manual install takes, pinned at the published version; a later
  publish by the same user re-pins them to it, other users' pins are
  untouched (their update-available marker works as before). The live
  `hubspot-investigate` row's description and manifest were corrected in
  place, and the pusher got their retroactive install record.
- **Rail tabs own URLs; tab switch resets the composer (2026-10-13).**
  Each sidebar tab now has its own address: `/chats` (default, `/` aliases
  to it), `/work` (also implied by `/project/<id>`), `/settings` (bare;
  sectioned `/settings/<section>` URLs remain the settings overlay, whose
  root-less form now canonicalizes to `/settings/account` because bare
  `/settings` is the tab). Tab picks navigate via pushRoute, so back/forward
  walks tab history and reloads/deep links restore the tab from the URL —
  the localStorage tab persistence is gone. Navigating to a tab root clears
  the open chat: switching Chats ↔ Work (or any tab) always lands on a fresh
  composer, never the previously selected chat. `ChatRoute` gained a `tab`
  field; `chatRoutePath` takes it as a fifth parameter.
- **Org-wide skills shipped (2026-10-13).** The 17-task plan
  (`docs/superpowers/plans/2026-10-13-org-skills.md`, spec
  `docs/superpowers/specs/2026-10-13-org-skills-design.md`) is complete and
  deployed: registry items gain team/owner ownership, maintainer gating and
  tombstone unpublish (revival via the editor route republishes at
  max-version+1); skill HTTP surface (catalog, detail with read_stats,
  source, install/uninstall/pin/gate/unpublish, fork, activity,
  member-scoped `/skills/teams`, caller-install listing `/skills/installs`);
  ClickHouse `skill_reads` sink feeding detail-page usage stats; agent tools
  `read_skill` (install-on-use, pinned, sha-verified) / `search_skills` /
  `push_skill` with one combined index section in the system prompt
  (8192-byte budget); `skills.sync_v1` MachineRequest converging pinned
  installs onto every machine (Rust app-server handler materializes to
  `~/.agents/skills/`, sidecar `agents/guild.yaml`, per-entry isolation);
  desktop Skills rail panel (catalog/activity tabs, detail with
  install/pin/fork/gate/unpublish, wiki-style editor with owner pick,
  Tauri-only local-machine group); composer mentions cover local + installed
  org skills only; settings' SkillsSection deleted (panel owns skill
  customization), RegistrySection keeps mcp/integration. Startup now applies
  `apps/server/migrations` via `schema_history` (the old by-hand ritual is
  retired). Branch `skills`, E2E verified live on :18080 (create -> read ->
  install-on-use pin -> panel counts -> activity feed).

- **Rust server deleted (2026-10-13).** `crates/server` git-rm'd — the R9
  gate (prod cutover + soak) superseded by maintainer's explicit order after
  the live E2E on the TS stack (real model turn with tool calls through the
  server-side sandbox, usage sink verified, wire parity diffed against the
  retired Rust image on a loopback port: all GET surfaces identical except
  TS's additive `org_id`/`user_id` on projects). Migrations moved to
  `apps/server/migrations` (the TS test harnesses were the only remaining
  reader of `crates/server/migrations`); the root `Dockerfile` (Rust image)
  deleted; provenance comments naming the Rust tree cleaned across the TS
  sources; README/AGENTS/deploy docs updated. Consequences: the dev stack
  is TS-only (:18080), prod (:18081) still runs the Rust server from its
  own checkout (`~/guild-live`) until its cutover — rollback for prod is a
  checkout of git history, not a build from this tree. Workspace now:
  protocol, guild-core, app-server, codex-execpolicy(+utils), desktop
  Tauri.

- **Sidebar icon rail — chats and project chats separated.** The chat
  sidebar grew a ChatGPT-desktop-style narrow icon rail (desktop only,
  always visible even when the panel is collapsed) with three tabs:
  Chats (workspace switcher, New chat, Recents, Archived), Work (projects
  with their fold-out chats), Settings (section rows that open the settings
  overlay at that section). The account menu moved to the rail bottom; the
  tab selection persists in `localStorage["guild.sidebarTab"]`. Recents
  now shows only stateless chats — project-bound chats appear only under
  their project on the Work tab (project rows carry an aggregate
  unread/generating dot, and `/project/<id>` deep links open the Work tab).
  The mobile drawer is pinned to the Chats panel (no rail there).
  `sidebarGrouping.visible` changed meaning accordingly (stateless only).

- **0.5.36 — read markers ride event `seq`, not event id.** Threads with a
  dead executor kept reappearing unread after every refresh: durable
  workflow events carry deterministic uuid v5 ids (idempotent replay), and
  the unread derivation compared event ids bytewise assuming uuid v7
  time ordering — an older event with a bytewise-greater v5 id counted
  unread forever, no matter how often the chat was opened. Migration 0066
  moves `chat_reads` to `last_read_seq BIGINT` (the global write order the
  marker already selected from), backfills from the stored ids, and the
  list projection + mark_read compare in seq space. Migrations are
  append-only: 0048 keeps its shipped schema, 0066 alone does the
  transform (editing 0048 broke fresh template builds with a duplicate
  column). Server-only; no client change.

- **Prod is a separate checkout** (`~/guild-live`, branch master, compose
  stack on :18081, public at guild.example.org). Deploy to prod by a
  deliberate merge of develop into its master (a release merge, e.g.
  "release 0.5.42 — merge develop into prod") — never a blind
  fast-forward: develop → master crossings are meant to be deliberate,
  and its docker-compose.yml carries prod-local edits, so never rebase it
  either. Then `docker compose build server && up -d` there. First
  multi-workspace deploy: 0.5.32 on 2026-09-30. The 0.5.22→0.5.32 jump
  exposed that an untracked migration file breaks the tree — migrations
  must be committed with the code that reads them.

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

- **Desktop 0.5.35 released (2026-10-04).** `scripts/release-clients.sh` run
  detached (systemd user unit, warm caches — 3.5 min wall) against the dev
  server; all four platforms published and server-side sha256-verified:
  Windows NSIS `Guild_0.5.35_x64-setup.exe`, Linux
  `Guild-0.5.35-x86_64.AppImage`, macOS DMGs + `.app.tar.gz` updater bundles
  (aarch64/x86_64). `/api/v1/updates/latest.json` serves 0.5.35 with all
  updater minisign signatures present — paired clients auto-update on their
  next 15-min check. Built from `agent-plane` (TS-server era: routines
  dropped — `RoutineStore` removed, registry install rejects automation
  bundles and the install response drops the `routines` field; M8
  integrations runtime; read-dot seq fix). Operator note: release publishing
  needs an admin session — a temporary one was minted directly in the dev
  DB for the run and revoked immediately after.

- **Read-dot fix: unread orders by seq, not event id (2026-10-04).** User
  report: read/unread not persisting on the TS branch. Diagnosis: read
  markers WERE persisted (route + rows verified live); the bug was the
  unread projection comparing `thread_events.id` — the turn-command
  idempotency contract makes the client's random uuid-v4 message id double
  as the user_message event id, and v4 sorts above every uuid-v7 harness
  event, so each chat pinned ~1 unread forever and the dot never cleared
  (Rust-era events were all v4, so id order was ill-defined there too —
  seq, the BIGSERIAL write order, was always the correct key, and mark-read
  already used it). Fix: the sidebar list and hub-feed unread projections
  now compare `e.seq > (marker event's seq)`; regression test covers a chat
  mixing v4 + v7 ids (read clears, new turn re-marks). 265/265 tests,
  redeployed, live-verified mark-all → 0 unread. Commit `fix` in
  `agent-plane` (see git log for hash).

- **Rust tree deletion prepared — `crates/server` fully decoupled (2026-10-04).**
  Two lanes. **TS side (direct, commit `f62a520`)**: exec-policy base rules
  relocated to `apps/server/assets/exec_policy_base.rules` (matcher default,
  Dockerfile build+runtime copies, tests updated) — the TS server no longer
  reads anything from the Rust tree at build or runtime. **Rust side (lane
  R9, `prep/rust-removal`, commits `0891b73`/`dc0df6e`/`06e5b14`)**:
  engine (`app-server`) and desktop tests that used `guild_server`
  test-support/build_router rewritten against hand-rolled mock routers
  (engine-side coverage preserved; Rust-server-internal coverage superseded
  by TS hub tests), `guild-server` dev-deps removed from both crates,
  `crates/server` dropped from the workspace member lists. Verified:
  `cargo check --workspace --all-targets` PASS, `cargo test -p app-server`
  PASS (80 lib + integration suites), protocol bindings generate and are
  fresh, dev stack rebuilt — exec policy loads from the new location
  (0 boot errors). **`crates/server/` remains on disk untouched**: deleting
  it is now a pure `git rm` gated on prod cutover + soak (rollback-image
  rebuild and the routines parity reference are the two remaining reasons
  to keep it until then). Report: `R9-REPORT.md` (git history).

- **M8: integrations chat runtime ported — the missing-tools regression fixed (2026-10-04).**
  The chat-loop integrations runtime was deferred (old decision 8) while the
  user's patent workflow runs on gmail/jira tools through chats, so after the
  M7 flip every turn answered `Tool google_workspace_gmail_search is not
  available`. Lane M8 (`feat/integrations-runtime`, commit `d233e8f`) ported
  the runtime from Rust (`crates/server/src/integrations/*.rs` ~3.4k lines +
  `restate.rs` chat flow): per-turn `{slug}_list_tools`/`{slug}_guide`
  registration with on-demand tool discovery and the system-prompt index,
  execute for all 7 built-in connectors (google_workspace incl. RS256 JWT
  service-account impersonation, atlassian, github, gitlab, slack, hubspot,
  langfuse, firecrawl, searxng), MCP `tools/call`, `always_ask` curation
  riding the approval-card gate, acting-as identity, `integration.tool_called`
  audit events, and the script API switched from the stub to real dispatch.
  pi-durable stays pinned 1.0.1. Verified: 264/264 tests (236 baseline + 28
  new, mock-server based — no external API calls in tests), typecheck clean,
  dev stack redeployed, LIVE check: `atlassian_jira_search` through the
  script API returned a real Jira issue (`ok:true`) with the audit event
  journaled; google_workspace left for the user to exercise with their own
  workspace identity. Spec decision 8 revised by this entry (dated
  amendment: integrations runtime in scope). Report:
  `M8-REPORT.md` (git history).

- **TS server architecture refactor: layers + narrow contexts (2026-10-04).**
  Two subagent lanes on `agent-plane` (prompt files + report verdicts, per
  the orchestration loop), dispatched on user instruction, fully autonomous:
  **R1 DAL separation** (`refactor/dal-layers`, commit `f559ef1`) — domain
  errors moved to neutral `platform/errors.ts` (wire shapes byte-identical),
  shared protocol code to `platform/domain/thread-events.ts`,
  `identity`→`EventStore` store-to-store import replaced by an injected
  `EmitOrgEvent` capability, raw route-level `BEGIN` transactions in
  `admin.ts`/`agents.ts` hoisted into store methods, and a new
  `src/test/arch-layers.test.ts` enforcing the import graph (stores must not
  import hub/harness/machines/chats/http/fastify; services must not import
  fastify). **R2 context decomposition** (`refactor/contexts`, commit
  `e72db91`) — `PlatformContext` demoted to composition root; route groups
  now receive narrow slices from `platform/contexts.ts` (Infra, IdentityCtx,
  ChatsCtx, GatewayCtx), cross-group stores passed explicitly; the
  `(app as any).platform` test-seam cast replaced by Fastify
  `app.decorate("platform")`; arch test also bans `PlatformContext` imports
  in `platform/http/*` outside `register.ts`. Both lanes verified
  independently after merge: typecheck clean, **236/236 tests** (was 230,
  +6 arch rules), suite run 3× green (one non-reproducing hub-test flake
  during lane R2 did not recur), dev stack rebuilt from the merged tree
  (`guild-server-ts:latest`), live smoke green: login + chats list + CORS
  preflight 204, 0 error lines in server logs. Lane reports:
  `R1-REFACTOR-REPORT.md` (git history), `R2-REFACTOR-REPORT.md` (git history).
  Layer rule now: http → services (harness/chats/hub/machines) → DAL
  (platform/store) → infra (db/crypto/time/s3/clickhouse).

- **M7 dev retirement complete — the ladder is DONE on the dev stack
  (2026-10-04).** The compose stack is TS-only (`compose-server-1`, image
  `guild-server-ts`); the Rust `server-rust` service and the
  proxy-everything layer are removed (routines/hooks/internal answer the
  clean 404 envelope — deferred per decision 8). Final verification:
  227 tests green (22 suites), headless client login + a real
  GLM-5.3-Flash turn through the all-TS stack (M7-SMOKE-OK), and the real
  shipped desktop daemon (WORKSTATION 0.5.33) linked through the TS hub with
  zero errors. Post-retirement trap fixed the same day: the Rust CORS
  layer (tauri-webview origin allow-list) had been riding the proxy —
  browser preflights (`/api/v1/ws/ticket`, `/faro/collect`) 404'd once it
  went away and the desktop web UI retry-looped; the layer is now ported
  natively (`src/http/cors.ts`, 230 tests incl. the CORS suite) with
  live-verified 204/ACAO behavior. The importer's re-runnability was
  additionally verified LIVE (2026-10-04, post-cutover): a second full run
  against the dev DB rebuilt 90 chats → 90 conversations, 3446 events →
  3446 entries exactly, documents preserved, turns healthy after
  (RERUN-SMOKE-OK); pre-rerun backup:
  `/tmp/guild-backup/guild-pre-rerun-0552.sql`. Prod ladder (`~/guild-live`, :18081)
  is the remaining step — held until maintainer validates dev (the plan
  gates prod on "after dev stabilizes"). Backup of the dev DB taken
  before the importer's final run:
  `/tmp/guild-backup/guild-2026-10-04-0332.sql`.
- **M1 platform core + M4 workspace sessions landed (2026-10-04).** M1:
  native auth (opaque sessions/argon2id/OIDC), org, events, attachments
  with 64 golden Rust fixtures replaying byte-semantically. M4: workspace
  agent sessions rooted at `workspaces/<org>/<name>` under `GUILD_DATA_DIR`,
  the exec-policy matcher at asset parity (32 rules), durable approval
  gates (block/resume), machine-tool dispatch over the hub (fake-daemon
  round-trip + real-daemon link verified), tool-artifact spill. Verified
  live: an agent-session turn wrote a file into the workspace sandbox and
  read it back; the policy correctly blocked shell tools with
  `GUILD_ALLOW_SHELL_TOOLS` unset (Rust parity). Reports:
  `M1-REPORT.md` (git history), `M4-REPORT.md` (git history).
- **M7 retirement landed (2026-10-04).** `apps/server` ported the last
  proxied surfaces on `m7/retire`: integration tool API (list, tools
  listing, execute with the Rust error/audit shapes; built-in connector
  tool manifests + test_connection; a minimal MCP streamable-HTTP client
  for plugin integrations — connect timeout 10s, MCP tool curation
  absent=disabled), the admin integration save path (create 409-on-dup /
  stub-create, update with secret merge + missing_secrets 409,
  test-then-persist; MCP config validation + live tools listing), and
  `GET/PUT /api/v1/me/approval` (desktop-client user approval policy, serde-
  exact validation texts). Secrets stay AES-256-GCM hex(nonce‖ct+tag) —
  all 9 live `integration_secrets` rows decrypt with the TS implementation.
  The proxy is gone: `GUILD_UPSTREAM_URL`, `@fastify/http-proxy` and the
  `server-rust` compose service removed; deferred routes (routines, hooks,
  internal — spec decision 8) answer the Rust 404 envelope; compose now
  runs the TS server only (with the `guild_data` volume for
  `$GUILD_DATA_DIR` workspaces). Full evidence + unported-route list +
  cutover runbook in `M7-REPORT.md` (git history). 227 tests green (22
  suites) on disposable `guild_m7_test_*` databases.

- **M6 long tail landed (2026-10-04).** The remaining M6 surfaces run
  natively in `apps/server` on `m6/longtail`: registry (S3-backed publish/
  review/install with the Rust bundle caps and manifest-validation error
  strings), releases (admin upload + ed25519 signing, signed download
  URLs, semver-exact updater `latest.json`), projects (the 0.5.34
  one-live-project-per-(machine,folder) rule with `folder_taken` 409,
  archive-frees-folder, chat machine-binding unlink), teams, admin users
  (last-admin guard + credential revocation on reset), org prompts
  (org_kv), admin integration reads + per-tool curation (row-lock RMW),
  faro ingest (exact-byte forward), and the chat-SPA serving (dist now
  built inside `Dockerfile.server-ts` stage `webui`, served from disk;
  golden byte check against the live stack is byte- and header-identical,
  `apps/server/scripts/m6-web-golden.ts`). Deferred still proxied with
  reasons in `M6-REPORT.md` (git history) §3: routines CRUD/internal API
  (spec decision 8), the integration save path + tools listing and the
  script-side `/api/v1/integrations/*` (need the connector ports + MCP
  client; unreachable at M7). 160/160 tests green (sequential file mode —
  parallel lanes exhaust Postgres max_connections on the shared host DB).
- **M5 hub core landed (2026-10-04).** The `InMemoryHub` seam became the
  real `LiveHub` (`apps/server/src/hub/`): member/machine registries, 32
  socket caps, the 0.5.25 live-slot rule (a live machine slot is held —
  foreign-instance connects are rejected 409, same-instance reconnects
  displace only their own zombie), displacement on re-pair, and
  `machine_request`/`machine_request_pinned` with exact
  `MachineRequestError` semantics. `GET /api/v1/ws` flipped native
  (single 'upgrade' listener; proxy `websocket:true` removed — rollback
  restores the flag + deletes `attachWsUpgrade`) with `POST
  /api/v1/ws/ticket` (`gst_`, 30s TTL, single-use), member + machine
  socket loops (heartbeat 5s/10s, session watch → AuthRequired, sink
  high-water 4096, 30s last_seen throttle), and `GET /api/v1/machines` +
  `POST /api/v1/machines/{id}/fs` over the durable machine registry
  (fingerprint adoption re-pair re-keying incl. `projects`/`chats`
  machine_id moves). Golden WS frames captured from a locally built Rust
  0.5.34 (disposable synthetic DB, not the live stack) and replayed
  byte-compared; 113/113 tests green; report in
  `M5-REPORT.md` (git history). Remaining for later lanes: feed forwarder,
  sync frames, tool-result completion, `reconcile_machine_tools` (all
  behind `ctx` seams).
- **M3 harness + chats cutover landed (2026-10-04).** `apps/server` now runs
  the durable agent engine itself: pi-durable 1.0.1 over the M3 Postgres
  storage (one owning process, `GUILD_SANDBOX_ROOT` exec env), model access
  as an OpenAI-compatible client looped back through the server's own
  gateway (`GUILD_SELF_BASE_URL`, internal key + `x-guild-org-id`, so
  harness turns are metered exactly like external calls; the gateway honors
  `stream_options.include_usage` — additive, default streams stay
  byte-identical). Chat CRUD / thread read+append / turn submission
  (`POST /api/v1/gateway/chat`) / stop / approval / compact / mark-read
  routes are native with serde-rejection + wire parity; `chat_conversations`
  maps each chat 1:1 to an ownerless durable conversation; the bridge
  persists run output as `thread_events` (ThreadState-byte-compatible rows)
  and settles `turn_commands`. New additive SSE surface
  `GET /api/v1/chats/{id}/thread/stream` pushes byte-exact ThreadState
  frames (verified against live Rust member-socket captures); the member WS
  itself stays proxied until M5. The re-runnable thread importer
  (`npm run import-threads`, `apps/server/src/importer/`) truncates +
  rebuilds `durable_*` + the mapping from `thread_events` — tested against
  real anonymized captures (314 events / 4 chats incl. approvals, tool
  loops, a compaction, an empty chat), idempotent rerun verified, CLI
  smoke-run done. Restate is removed from the compose stack
  (`server-rust` runs `GUILD_ROLE=api`). Machines routes stay proxied and
  `machine_online` stays false until M5 (documented deviations).
  95/95 tests green on disposable `guild_m3_test_*` databases; report in
  `M3-REPORT.md` (git history).

- **M2 LLM gateway landed (2026-10-04).** `apps/server` serves the OpenAI
  and Anthropic completion surfaces natively (`/openai/v1/*`,
  `/anthropic/v1/*`) with byte-compatible SSE (verified against 12
  live-capture golden fixtures, both streaming dialects), org API keys
  (`gk_*`, sha256-at-rest, auth_generation stamping), month-to-date quota
  enforcement via ClickHouse `usage_events`, usage/series/summary
  endpoints, gateway admin providers/routes CRUD, and the env-minted
  `GUILD_INTERNAL_KEY` loopback key (org scoping via `x-guild-org-id`,
  synthetic internal uuids for usage attribution — no schema change).
  `/api/v1/gateway/chat*` stays proxied until the M3 chats cutover.
  81/81 tests green on disposable `guild_m2_test_*` databases; report in
  `M2-REPORT.md` (git history).

- **M3 storage core landed early (2026-10-04).** The pi-durable Postgres
  storage backend (`apps/server/src/storage/postgres/`: durable_\* tables
  per design decision 5, portable core + pg adapter) passes pi-durable's
  full conformance suite (23/23), reopen-across-restart tests, and
  benchmarks. pi-durable 1.0.1 gaps found so far are recorded as a dated
  spec amendment. The rest of M3 (harness wiring, chats routes + SSE,
  importer, restate removal) follows M2's internal gateway key.
- **M0 — TS server shell cutover landed (2026-10-04).** `apps/server`
  (Fastify) serves `/api/v1/health` natively and proxy-everything (HTTP + WS
  upgrade) to the Rust server on the compose network; TS container
  (`guild-server-ts`, tsc at build time) owns the public port :18080, Rust
  service renamed `server-rust` (internal only). Verified on the dev stack:
  login + a real GLM-5.3-Flash turn end-to-end through the proxy via the
  headless client, and real desktop daemons (WORKSTATION 0.5.33, devbox 0.5.25)
  reconnected and working through it. Trap found: renaming the Rust service
  must move `GUILD_WORKER_ADVERTISED_URL` to `http://server-rust:9080` or
  restate's deployment discovery 500-loops and every ChatRunner turn hangs;
  the stale `http://server:9080/` deployment had to be force-deleted from
  restate. Spec amendment recorded: sessions are opaque tokens in the
  `sessions` table, not JWTs. Design:
  `docs/specs/2026-10-04-ts-server-pi-durable-design.md`; milestones:
  `docs/plans/2026-10-04-ts-server-pi-durable-plan.md`. Work branch:
  `agent-plane` (worktree `~/guild-wt-agent-plane`).
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
  stack on :18081, public at guild.example.org). Deploy to prod by a
  deliberate merge of develop into its master (a release merge, e.g.
  "release 0.5.42 — merge develop into prod") — never a blind
  fast-forward: develop → master crossings are meant to be deliberate,
  and its docker-compose.yml carries prod-local edits, so never rebase it
  either. Then `docker compose build server && up -d` there. First
  multi-workspace deploy: 0.5.32 on 2026-09-30. The 0.5.22→0.5.32 jump
  exposed that an untracked migration file breaks the tree — migrations
  must be committed with the code that reads them.

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

- **Schema-first protocol types (protobuf or similar), dropping the
  Rust-side ts-rs generation** (maintainer, 2026-10-14): define the wire types
  once in a language-neutral IDL and generate both the Rust and TS types
  from it, instead of Rust being the source of truth with ts-rs emitting
  `crates/protocol/bindings/*.ts`. Removes the npm-workspace-inside-crates
  oddity and the per-type export tests. Precondition for picking the tool:
  it must preserve the freshness gate (generated-vs-committed diff) and the
  64-bit wire-field number handling (`ts(type = "number")` today).
- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `2026-09-24-loop-summary.md` (git history) for the per-surface pass counts
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
  out of the repo root (reports live in git history).
- Comments describe what code IS and does now — no history narration. Docs
  like this file carry the story.
