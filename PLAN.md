# Guild — current state of work

Updated 2026-09-14 (machine presence fixes, per-chat approval selector,
Windows desktop 0.3.20 live-tested on devbox). Read this before touching the codebase; detailed
milestone plans live in `docs/plans/`, deploy nuances in
`docs/deploy-nuances.md`, hang-patterns in `~/workspace/hanging-commands.md`.

## Machine section copy tightened (0.3.25–0.3.26)

Per maintainer: machine binding happens on entering the device sign-in token
(pairing), not per chat — and the long "machine tools execute on the
machine bound to the chat" header explanation is unnecessary. The Machine
section now leads with just the title and the connected-machine inventory;
the single remaining note explains that machines bind at device sign-in and
appear here, with per-chat switching available from a chat. Empty state and
note reworded to the device-token flow.

## Machine settings show the inventory without a chat (0.3.24)

The Machine section dead-ended with "Open a chat to bind it to a machine"
whenever settings were opened without a chat selected — it hid the machine
inventory entirely, which read as "machine binding does not work" even
though binding itself was fine (new chats auto-bind the local executor,
machines register by heartbeat, tools dispatch). The section now always
renders the connected-machine list (the endpoint only returns fresh-heartbeat
machines, so a pulsing green dot marks them connected), with bind/unbind
controls when a chat is open and a per-chat explanation when not. The thread
header's bound-machine chip is now a button that opens Settings at the
Machine section for one-click rebinding. Desktop 0.3.24 published, installed
on devbox, both states verified via CDP.

## Approval modes adopt the codex vocabulary + "Approve for me" AI policy (0.3.23)

The composer's per-chat approval selector now mirrors codex exactly:
"Ask for approval" (always ask), "Approve for me" (only ask for actions
detected as potentially unsafe), "Full access" (unrestricted), plus the
"Account default" row that clears the chat override. The old allow/never
values are remapped by migration 0044 (allow→full_access; never drops the
key and falls back to the account policy — chat-level deny is gone).

"Approve for me" runs a real AI auto-approval policy: before each tool, a
model judge (the chat's own model, journaled call, 30s timeout) receives
the action JSON under an admin-tunable policy prompt and answers
{"approve", "reason"}; approve → the tool runs silently, anything else →
the usual approval card. Timeout, parse failure, or provider error all
fall back to asking (the safe direction). The policy prompt is a new org
setting (org KV `assistant_approval_policy_prompt`, admin endpoints
GET/PUT /api/v1/admin/approval-policy-prompt) shown in Settings →
Assistant next to the system prompt — both fields render the CURRENT
effective text filled in (the default as the value, never a placeholder),
with save/reset per field.

Verified live on devbox (0.3.23): picker renders the codex entries with
icons; in "Approve for me" a benign `date /t` auto-ran with no card (judge:
"read-only… harmless") while `del %TEMP%\…` was flagged (judge: "destructive,
irreversible… outside the workspace") and surfaced a card; approving it
completed the turn. Settings shows both prompts as filled text.

## Shell tools no longer flash a console window (0.3.22)

Every execute tool call on the Windows desktop popped a cmd window for the
command's lifetime: the host is a GUI-subsystem process, so each cmd.exe
child got a freshly allocated console. Fixed in guild-core's shell tool:
CREATE_NO_WINDOW (0x08000000) on spawn, and stdin pinned to null — the
latter also fixes interactive prompts (bare `date` waits on inherited
stdin, hanging until the 30s timeout). Verified live on devbox: a ~6s ping
approved and executed in the GUI while a window-title poll (12 samples)
and a full-desktop screenshot both show no console window; exit code 0 and
full stdout captured.

## Approval decision deadlock fixed (2026-09-14)

Ask-mode approvals hung forever: the turn's generate awaits the approval
awakeable, and per Restate a virtual-object handler awaiting an awakeable
keeps the instance locked — so this morning's `claim_approval` (cb9f84e), an
EXCLUSIVE wake handler invoked on the same object, inboxed behind the
waiting turn forever and the decision could never land. Observed live: the
auto-deny timer's claim ran and found the key absent (the stuck
invocation's state never applied — restatedev/restate#5196 class), and a
fresh turn's claim vanished silently behind the lock. Upstream issue #5196
describes the wider "suspended with open Run completion" jam; worker
restarts and re-registration do not recover it; only killing the invocation
(or wiping restate's container layer — it mounts no volume) frees the key.

Fix: the resolution moved back into the shared `complete_approval` handler
(mirroring `complete_tool`), and the exclusive `claim_approval` handler was
deleted; first-answer-wins is enforced by Restate dropping late completions
for an already-resolved awakeable, and the waiting turn clears the state key
on resume. Verified end-to-end in the GUI on devbox: Ask mode → Approve →
decision journaled → tool dispatched and executed on the WORKSTATION machine →
answer rendered; no duplicate thinking block (the catch-up thinking buffer
now replaces the turn's existing reasoning block instead of appending one
below the approval card); execute approvals render a terminal-style
`$ command` line instead of the raw JSON args. Desktop 0.3.21 published and
installed on devbox.

Operational notes from the same incident: deploys kill in-flight turns (the
worker does not drain); the restate container has no volume so its state
lives in the container layer (`restart` keeps a jam, `rm` clears it); the
stuck-generation sweep only kills version-mismatched invocations — this jam
had a matching restate.rs hash, so the sweep skipped it.

## Composer approval-mode selector (2026-09-14)

The codex-style "how should tools be approved" control now lives in the
composer itself (pill next to the folder chip): per-chat mode with four
entries — Account default / Ask for approval / Auto-approve / Deny tools.
Backend: migration 0043 (`chats.approval` jsonb), owner-scoped
GET/POST `/api/v1/chats/{id}/approval` (`{"default": "ask"|"allow"|"never"|"default"}`),
and the approval gate reads `c.approval` first, falling back to the
account-level policy (`u.approval`, Settings → Approvals keeps the
user default + per-tool overrides — those apply only while the chat is on
the account default). Verified behaviorally on devbox with the WORKSTATION
machine: `allow` runs write_file with no card, `never` returns
"denied by policy" without dispatching, ask keeps the card flow. Desktop
0.3.20 built, published, installed on devbox; server deployed.

## Machine presence + link robustness (2026-09-14)

Root causes of the recurring "No machines connected" while a desktop app
was installed (devbox/Windows): the link stream dies every few minutes
behind Cloudflare (`error decoding response body`, reconnect gap ~19s), and
three bugs turned each flap into an outage: (1) the server's
`ExecutorGuard::drop` unregistered the machine the moment the stream
dropped; (2) the desktop spawned its heartbeat loop inside the stream
connection and aborted it with the stream — the documented design says
heartbeats run independently; (3) Cloudflare keeps the origin leg of a dead
client connection open, so per-user stream permits leaked until the cap
(3/user) 429'd every reconnect — observed live (`stream connect: HTTP 429`
in the app's rpc.log). After a server redeploy the zombie is worse: silent
(no bytes, no error), so the app never reconnects and stops receiving tool
frames while heartbeats keep it "present".

Fixes (all verified live on devbox): server — `ExecutorGuard::drop` is a
no-op (TTL is the offline signal, `EXECUTOR_TTL_SECS` 15→30) and a new
connect for the same `machine_id` evicts the previous link stream via a
versioned `watch` (`AppState::machine_link_signals`), reclaiming leaked
permits; desktop — the heartbeat loop moved out of `link_once` into
`app_link_task` (survives flaps) and the link read loop has a 90s stall
watchdog (keepalives every ~30s; silence → reconnect). Desktop version
0.3.19 built (NSIS via cargo-xwin), published to /api/v1/updates, installed
on devbox; local tool calling driven through the GUI via WebView2 CDP
(SSH-tunneled 9222): read_file executed on the Windows machine and the
content returned in-thread. Note for GUI automation: the webview re-pushes
the workspace dir from `localStorage["guild.dir:<chatId>"]` on every send —
setting it via direct `set_chat_dir` invoke alone gets overwritten with
None.

## Tool kind + namespace cleanup (2026-09-14)

- Every `ToolSpec` carries a top-level `kind: ToolKind` — `web_search`,
  `web_browse`, or `generic` (serde/default `generic`). Set semantically on
  the in-code web integrations: searxng `web_search` → `web_search`,
  superproxy `web_fetch` → `web_browse`, firecrawl `search` → `web_search`,
  `scrape` → `web_browse`, `map` → `generic`. Everything else defaults to
  `generic`. The provider request builders pick only
  name/description/parameters, so kind never leaks to the model wire.
- The thread UI labels frames by kind first ("Web search" / "Browse"), so
  firecrawl calls render natively instead of "firecrawl search". Kind rides
  on `ThreadEvent::ToolResult` (serde default; old events lack it) and on
  `StreamEvent::ToolStarted` for live frames; pre-kind events fall back to
  the widget meta kind, then to the bare tool name.
- The `int_` tool-name prefix is gone globally: wire names are now
  `<slug>_<tool>` (e.g. `searxng_web_search`, `firecrawl_scrape`), auto
  tools are `<slug>_list_tools` / `<slug>_guide`. `unnamespaced_tool` still
  strips the legacy `int_<slug>_` shape and `parse_auto_tool` tolerates the
  legacy prefix, so journals recorded before the rename replay and old
  thread events keep rendering. Registry manifest tool-name length cap
  adjusted (64 − slug − 1).
- The system-prompt web-search instruction is kind-based now (fires when a
  permitted tool has kind `web_search`, wording "web-search tools (kind
  web_search)") instead of matching the literal tool name.
- TS bindings regenerated (new `ToolKind.ts`; `ToolSpec`/`ThreadEvent`/
  `StreamEvent` updated). Suite 308 passed across server/protocol/core/
  app-server; desktop vitest 14 passed; deployed to :18080 (new bundle
  hash, health ok).

## Providers are named, editable objects (2026-09-14)

- A provider is now `{slug, name, protocol, base_url, key}`: the display
  name is free-form ("openai" names a wire protocol, not a provider), the
  protocol (`openai` | `anthropic`) selects the provider implementation,
  and model routes keep referencing the stable slug. Migration 0040
  backfills name/protocol from the legacy slug (which was doubling as both).
- Admin API: `GET/POST /api/v1/admin/gateway/providers`,
  `PUT/DELETE /api/v1/admin/gateway/providers/{slug}` — slug derived from
  the name (lowercase, dash-joined), 409 on duplicates, blank key on update
  keeps the stored key, unknown protocol 400. The old `/keys` endpoints are
  gone. Route resolution falls back to slug-as-protocol when the provider
  row is gone (pre-0040 shape); a deleted provider's routes fail
  `key_missing` (the LEFT-JOIN NULL decode used to surface as a 500).
- The wire-protocol match moved into `guild_core::provider::for_protocol`;
  all six call sites use it. `RouteRow`/`RouteMeta` carry `protocol`
  (serde default for old journals); usage still records the slug.
- UI (Models section): providers are a data table with their own
  URL-addressed sub-pages — `/settings/models/provider/new` and
  `/settings/models/provider/<slug>` (detail = fact cards + Edit + two-step
  delete; routes show the provider's name, add/edit pick from a provider
  select). Live: renamed the seeded provider to "Local gateway".
- `useCachedGet` gained a `settled` flag (fetch completed on this mount):
  provider detail uses it to render "not found" only after a fresh fetch,
  not on a stale pre-create cache (the create→navigate flow flashed
  not-found without it).
- SPA fallback fix (`http/web.rs`): dotted non-API paths (model ids,
  provider slugs like `v1.5`) used to 404 because the fallback skipped
  anything containing a dot; now a real bundled file wins and everything
  else serves index.html. Live-verified:\  `/settings/models/GLM-5.3-Flash`
  deep-links again.
- Verified live on :18080 via agent-browser: providers list/detail/edit
  (renamed openai → Local gateway), create (slug `scratch-test-co`,
  anthropic protocol) → deep link → delete, deleted-slug not-found page,
  route detail/edit provider select, and an end-to-end chat turn through
  the renamed provider (streamed + usage recorded). Suite 212/214 (the 2
  stragglers are the known load-flaky SSE fan-out tests; pass in isolation).
  Note: test runs need `GUILD_TEST_PG_URL` exported (removed in the S8
  security round); host-postgres admin creds are in `/srv/postgres`.

## Review loop rounds 4–8 (2026-09-14) — exited CLEAN

- Two-lane review loop (security + features/correctness) ran to its exit
  condition: round-8 reviews returned CLEAN on both lanes. Reports in
  `docs/reviews/2026-09-14-*-round4..8.md`; every fix round was verified by
  a separate verifier pass before reviewers re-entered.
- Fixed along the way: registry approval now binds to the exact manifest AND
  bundle sha256 (`reviewed_version`/`reviewed_bundle_sha256`, migrations
  0037/0038, content-addressed bundle objects, approve requires
  version+hash and 409s on stale) — republished/byte-swapped bundles cannot
  govern access without re-review. Legacy (hashless) rows fail closed until
  an admin re-approves after a republish. `guide_object_key` resolves only
  approved skills and degrades to "no guide" on store errors. Events SSE is
  capped (64 global / 3 per user). The stuck-generation sweep parses
  `version:invocation` and kills only on confirmed stale. Turn-failure path
  no longer duplicates a persisted assistant turn (`step_persisted` set at
  stream start, buffers cleared after persist). Desktop: busy stays set
  until the fan-out done/error frame; attachment chips swap to uploaded ids
  before composer URLs are revoked; engine-approval timeouts release their
  pending entries; IntegrationDetail resets across navigation.
- Deployed to :18080 after each fix round (health ok). NOTE for admins:
  registry integrations/skills approved before migration 0038 stop
  resolving/downloading/installing for members until re-approved (fail-
  closed transition, by design).

## Admin UI rework: data tables + polish kit (2026-09-13, branch `admin-ui-rework`)

- Full settings rework, design decision in `docs/admin-ui-options.md`, plan
  in `docs/plans/2026-09-13-admin-ui-rework.md`. Foundation: generic
  **DataTable** (`packages/ui/src/components/data-table.tsx`, TanStack
  Table v8 — search, sortable columns, pagination, row click, loading
  skeleton, empty state), **AlertDialog** confirm dialogs and a themed
  **sonner Toaster** (`packages/ui`, mounted once in App). Settings-local
  primitives in `apps/desktop/src/views/settings/components/`:
  PageHeader (title + description + actions + breadcrumb back), Field,
  EmptyState, FactCard/FactGrid.
- Reworked sections: Users (table w/ 30d spend sparkline + fact-card detail
  + AlertDialog delete), Teams (table + members card), Models (keys cards +
  routes table + dialog-driven add key + fact-card detail), Integrations
  (one unified table — configured rows + not-configured catalog entries with
  status column; detail keeps JSON config, secrets, tool policy, all deletes
  confirmed via dialogs), Registry (unified table w/ kind + review columns,
  fact-card detail), SSO (fact cards + remove dialog), Usage (header restyle,
  text-sm tables), Approvals/Assistant (Field + toasts), Account/Appearance
  (PageHeader + FactGrid). Sidebar active rows get a leading indicator bar;
  content column widened to max-w-4xl; every section renders its own
  PageHeader (the SectionPane title was removed).
- All destructive actions (delete user/team/route/key/integration/secret/SSO)
  are AlertDialogs with semantic red confirm buttons; all save/delete/add
  actions toast success/failure. Endpoint shapes and URL routing unchanged.
- Verified: tsc + vite clean; deployed to :18080 (compose build+up);
  browser-clicked users list/detail, teams, models, integrations, SSO and
  the delete-team confirm dialog (cancelled, nothing deleted).

## Seamless navigation: stale-while-revalidate everywhere (2026-09-13)

- Settings sections no longer flash a skeleton on every navigation. A
  module-level GET cache (`apps/desktop/src/views/settings/use-cached-api.ts`)
  keeps the last successful response per path; `useCachedGet` renders the
  cached value immediately on mount and refreshes in the background, so
  back/forward and section switches update content in place. Skeletons
  appear only on the first-ever load of a path; a failed refresh keeps the
  cached content on screen. Query paths with dates (usage series, spend)
  quantize timestamps to 10-minute buckets (`quantizeIso`) so cache keys
  repeat across navigations.
- Rewired onto it: Integrations (list + secrets), Users (list + 30-day
  spend), Teams (list + members + org users), Models (routes + keys +
  detail), Registry (3 kinds + item detail), SSO, Usage (summary +
  breakdown + timeline), Machine (module-level last list). WebChat keeps a
  per-chat rendered-block cache (bounded, 20 threads): reopening a thread
  shows its last rendered content while the fresh thread rows load in
  place, so chat switches don't skeleton-flash either.
- Desktop 0.3.17 released (all 4 platforms, installer format, updater
  signatures verified) and compose server rebuilt on :18080 — both
  include this, the integration id-addressing below, and the earlier
  integration-category fix (rows carry `category`, so configured built-ins
  like gitlab no longer show under "MCP plugins"). devbox's desktop app
  upgraded in place (silent NSIS + relaunch).

## Integrations are id-addressed db objects (2026-09-13)

- Every configured integration — built-in connector or registry MCP plugin
  — is a db row with a stable id. Migration 0030: `integrations.id UUID`
  becomes the primary key; `(org_id, name)` stays UNIQUE, so the resolver,
  secrets store (still keyed by connector slug) and tool namespacing
  (`int_<slug>_<tool>`) are unchanged.
- Admin API: rows carry `id`; `POST /api/v1/admin/integrations {name}`
  creates a configuration row (409 `already_configured` if one exists,
  404 for unknown connectors) and returns the row; `PUT` / `DELETE` and
  the secrets endpoints moved to `/api/v1/admin/integrations/{id}[/secrets]`
  — the by-name routes are gone. Secrets can only be staged on an existing
  row now (the UI creates the disabled row first).
- UI: the integrations list opens detail pages by id
  (`/settings/integrations/<id>`, deep-linkable); clicking a not-yet-
  configured connector creates its disabled row and lands on its id; a
  deep link to a deleted id renders a not-found note.
- Tests updated to the id flow (builtin_plugin, admin_integration_policy
  incl. a new create/conflict/unknown/delete round-trip test); all 27
  integration tests green, desktop tsc + vite clean. Deploy + desktop
  release happen with the concurrent 0.3.17 build (peer session).

## Single-process desktop (2026-09-13)

Spec `docs/specs/2026-09-13-single-process-desktop.md`, plan
`docs/plans/2026-09-13-single-process-desktop.md`. Trigger: the webview held
presence (its SSE died 2ms after boot and never retried) while execution sat
in the daemon → chats worked but every machine tool failed "bound machine
offline".

- **One process**: the GUI hosts the engine (session, JSON-RPC dispatch,
  local tool execution). No headless daemon, no cross-process pipe, no
  supervisor/build handshake. Window close → tray; real exit from the tray
  menu; single-instance plugin. The CLI socket is still hosted — by the GUI
  process (own restored session); `daemon::attach` no longer spawns anything
  and fails cleanly when the app is closed.
- **One standing connection**, owned by the app process (not the webview):
  events/stream with machine params = registration (executor_acquire) +
  **user fan-out bus** — every frame of the user's chats (deltas, thinking,
  tools, approvals, done/error), wrapped {chat_id, machine_id, event}, to
  every connected device; in-flight state replayed on connect/reconnect
  (buffer snapshots + suspended tools). Heartbeats (5s) UPSERT the machine,
  so a stream flap never unregisters a running app.
- **In-person execution**: the app process executes client tools when the
  bus delivers ToolStarted for a chat bound to its machine (chat→dir map
  pushed by the webview's run-in-folder state via set_chat_dir), then POSTs
  the result. No folder mapped → error result telling the user to use "Run
  in folder…". Webviews render only; web clients unchanged.
- Webview turn flow (desktop): send = fire-and-forget POST (sendChatNoStream,
  SSE body dropped); frames arrive as `app-frame` Tauri events routed by
  chat_id with per-chat seq watermarks; catch-up = `chat_snapshot` (the
  app process's in-flight mirror). app-stream-reconnected → thread reload +
  re-snapshot.
- Verified locally (xvfb smoke): boot without panic, link registers
  (heartbeat upsert), full tool loop end-to-end via API (dispatch → execute
  → result POST → model continues; folder-less error message rendered),
  CLI `chat` verb against the hosted socket, CLI fails cleanly with no app.
- Desktop 0.3.16 pending release; devbox deploy pending.

## Distinct URLs for all pages; settings sub-pages (2026-09-13)

- Every distinct page now has its own URL. Settings sections already had
  `/settings/<section>`; the sub-pages inside them were component state
  (refresh/back lost them, no deep links). They are now URL-driven:
  `/settings/integrations/<slug>`, `/settings/users/<id|new>`,
  `/settings/teams/<id|new>`, `/settings/models/<model|add>`,
  `/settings/registry/<kind>/<slug>`. Each detail segment is
  encodeURIComponent-ed per path segment, so model ids containing `/`
  round-trip.
- Plumbing: settings overlay route gained a `detail` part (parseChatRoute /
  chatRoutePath / pushRoute in WebChat); SettingsWindow forwards
  `detail` + `onDetailChange` through SectionPane/SectionBody/LazySection;
  sections with sub-pages (Integrations, Users, Teams, Models, Registry)
  take their open page from props (shared `SectionDetailProps` in
  `settings/section-nav.ts`) instead of local state.
- Create flows land on the created object's own URL
  (POST /admin/users and /admin/teams return the id →
  `onCreated(id)` → `/settings/users/<id>`).
- Deep-link loading guard: detail pages wait for the list fetch before
  resolving the id, so a fresh reload never renders a configured item as
  the "not configured" draft form (hit on slack on first verification).
- Verified live on :18080 via agent-browser: deep links render the right
  page after full reload (integration, user, model add, registry item),
  click-through pushes the URL, browser back returns to the section list.
- Deployed to the compose stack (:18080).

## Run in folder, context-aware UI (2026-09-13)

- The desktop chat regains "run in folder" (lost when AgentView was retired
  from the surface): a composer chip — "Run in folder…" picks the workspace
  before sending, chip shows the folder with an ✕. Web (browser) clients
  render none of it; the chip is desktop-only (`isTauri`).
- Per chat: folder remembered in localStorage (`guild.dir:<chatId>`, plus
  `guild.dir:last` as the default for new chats), restored on thread switch;
  sent per turn as `project_dir` on the gateway request (server plumbing
  pre-existed — build_system_prompt names the workspace); the local tool
  executor runs in that folder (mid-turn blind folder picker kept only as a
  fallback when no folder is set).
- Deployed to the compose stack (:18080) — browser UI live. Desktop 0.3.15
  published (all four platforms, sha256-verified; updater manifest is
  Host-relative, so artifact URLs follow the endpoint the client fetches
  from). Released via `scripts/release-clients.sh` with an admin session
  minted directly in the guild postgres (revoked after the run; the old
  debug token is dead). systemd-run jobs need the full PATH
  (`~/.cargo/bin` for cargo-xwin, nvm node for npm) or the windows build
  fails with `cargo-xwin command not found`.
- Deployed to devbox (the Windows host): new exe copied over
  `AppData/Local/Guild/guild-desktop.exe` (old one kept as
  `.0314.bak`), running daemon killed first, GUI relaunched. NOTE: the
  installed layout is the raw exe (not the NSIS app dir) — devbox updates
  are manual exe copies; the auto-updater would have delivered the NSIS
  installer instead.
touching the codebase; detailed milestone plans live in `docs/plans/`,
deploy nuances in `docs/deploy-nuances.md`, hang-patterns in
`~/workspace/hanging-commands.md`.

## Milestone 10 — unified plugins + real connectors (2026-09-12)

- Built-in and MCP integrations sit behind one interface: every
  `Integration` carries an in-code manifest (`in_code_manifest`, validated
  by the registry's own `validate_v2`), `execute` receives resolved
  secrets and the call's `acting_as` identity, and one resolver
  (`resolve_plugins` → `PluginTurn`) covers both kinds — same classes,
  policy filter, auto-tools, script API, and audit. An installed registry
  v2 bundle of a slug shadows a same-named built-in
  (`upsert_integration`, available list, secret-delete, resolver all
  follow that rule).
- Seven compiled-in connectors ship, all seeded with the credentials from
  internal project and live-smoked through the script API on :18080: slack
  (conversations, users, post_message), github (search, issues, PRs,
  files, create_issue), gitlab (self-hosted via `base_url` config,
  projects, issues, MRs, create_issue), atlassian (Jira + Confluence,
  basic auth), google_workspace (service-account JWT → DWD `sub` =
  acting identity; Gmail/Calendar/Drive/Directory), hubspot (CRM search;
  the internal project key is read-scoped so `update_deal` cannot fire live),
  langfuse (traces, `get_prompt` — the API requires a name, so there is
  no list-all tool).
- Slack's incoming-webhook tool was dropped: no webhook URL exists in
  internal project; `post_message` covers posting.
- Live smoke results: every read tool returned real vendor data; the
  slack write path fired for real (test message in #general);
  `create_issue`/`create_page` writes are wiremock-verified only (firing
  them would leave persistent artifacts in shared repos). hubspot
  `update_deal` is wiremock-verified only (read-scoped key).
- Secrets loaded via the admin API from `~/acme/internal project/.credentials`
  (loader script: `~/workspace/projects/m10-load-secrets.sh`, values
  never echoed). gitlab's `base_url` is the full API root
  (`https://gitlab.acme.dev/api/v4`); langfuse host is a secret.
- Plan: `docs/plans/2026-09-12-milestone-10-unified-plugins.md`; branch
  `integrations-v2-connectors`.


## UI pass — 16px text, floating scrollbars, settings sidebar (2026-09-12)

- Body text moved to the 16px base: all `text-sm` usages in the desktop
  app are now `text-base` (tiny `text-xs`/`[10px]` labels and pills
  unchanged).
- Floating scrollbars: native bars hidden (zero width, no reserved
  gutter); `scroll-activity.ts` renders a floating thumb over each
  scrolling container's right edge, visible only while it scrolls
  (~0.7s after the last event). Horizontal scrollers have no indicator.
- Settings sidebar resizable, sharing the chat sidebar width
  (`lib/sidebar-width.ts`, one localStorage key + same-tab resync
  event). Window-corner dialog X hidden for the fullscreen settings
  dialog (DialogContent gained `hideClose`); sidebar close button kept;
  Esc still closes.
- Per-chat cost chip removed from the thread header
  (ChatSpendChip.tsx deleted; /chats/{id}/usage endpoint untouched).

## Milestone 9 — integration plugin system (2026-09-12)

- Org integrations are now installable plugins: a registry bundle (kind
  `integration`) whose manifest v2 declares an MCP server url (streamable
  HTTP), auth shape (`org_secret` | `org_secret_impersonated` |
  `per_user_token`), per-tool classes (read/write/admin), triggers
  (routines), and guide skills. Spec:
  `docs/specs/2026-09-12-integration-plugins-design.md`; plan:
  `docs/plans/2026-09-12-milestone-9-integration-plugins.md`.
- The worker connects to enabled MCP plugins at turn start (journaled
  tool-list snapshot; connections pooled in AppState keyed by
  slug/url/acting-as/secrets-fingerprint), exposes namespaced tools
  `int_<slug>_<tool>` plus Guild-provided `int_<slug>_list_tools` and
  `int_<slug>_guide` disclosure tools, and enforces tool classes before
  execution. Compiled-in Rust plugins (searxng, superproxy) unchanged.
- Identity envelope on every MCP call (spec §5): org / caller /
  acting-as / call-id headers + secret headers; acting-as override is
  admin-only. Secrets encrypted at rest (0029_integration_secrets).
- Script surface: `GET /api/v1/integrations`,
  `GET /api/v1/integrations/{slug}/tools`,
  `POST /api/v1/integrations/{slug}/tools/{tool}` — session or org-API-key
  auth, policy-filtered, audited (`integration.tool_called`).
- Deployed to the compose stack (:18080); health + new routes smoke-verified.

## Desktop 0.3.10 — first release carrying the service-worker retirement (2026-09-12)

- 0.3.9 was cut ~12 h before the PWA service worker was retired
  (a2c0d64), so it still registered `sw.js`. On at least one Windows
  client the registered worker intercepts the `tauri.localhost` document
  request and the load hangs forever (DevTools: 1 request, Pending, 0 B;
  black window). 0.3.10 ships the retirement; its cleanup script only
  runs once a page loads, so a client whose worker already hangs the
  document needs manual WebView2 profile cleanup — the update cannot
  reach it through the updater.
- Also carries: settings at top-level /settings/<section>, /admin console
  removed (settings is the single admin surface).

## Settings: users add-flow, teams, SSO (2026-09-12)

- Users section reworked to the integration-style flow: list screen +
  "Add user" entry; the detail screen creates a user (email/password/role)
  or edits an existing one (role change, password reset, delete). New
  endpoint: PUT /api/v1/admin/users/{id} (IdentityStore::update_user).
- Teams section added (ORGANIZATION → Teams): list with member counts, add
  team, detail manages members (add from org users / remove) and delete
  team. Store: TeamStore gained list_members/remove_member/delete_team;
  TeamRow now carries member_count.
- SSO section added (ORGANIZATION → Sign-in / SSO): issuer / client id /
  client secret form (blank secret = keep current), remove-config, and the
  redirect URI to register at the IdP. Endpoints: DELETE /admin/oidc,
  public GET /api/v1/auth/oidc/status (single-org resolution).
- OIDC login is now a browser flow: redirect_uri and the post-login app
  redirect derive from the request's Host/scheme (not GUILD_API_URL, which
  is the internal docker address); callback redirects to the app with the
  session token in the URL fragment; WebLogin offers "Continue with SSO"
  when status reports configured, and app boot adopts the fragment token.
- Deployed to the compose stack (:18080); health + status endpoints
  verified live; UI flows not yet clicked through in the browser.
- Uniform admin state machine applied to Users, Teams, Integrations and
  Models: detail screens show saved data as read-only facts with explicit
  Edit (draft form with Save/Cancel) and two-step destructive confirms;
  no more always-live mixed forms. Teams gained rename (PUT
  /api/v1/admin/teams/{id}); integrations' enable toggle moved into the
  edit form. Registry already conformed; Usage/Approvals left to the
  session editing them.

## Desktop 0.3.13 (2026-09-12, latest)

- Poll-based rpc bridge: rpc_submit returns the request id in <1ms; a single
  rpc_poll loop drains completed envelopes to the webview. No invoke stays
  open for the duration of a daemon call, so the Windows-only hang (WebView2
  silently losing long-lived WebResourceRequested responses on maintainer's
  machine - daemon and pipe verified healthy in situ) cannot strand the UI.
  120s sweep injects timeout envelopes; reader exit drains pollers too.
- ipc trace (%TEMP%/guild-rpc.log) ships in every build; pipe_probe example
  for in-situ client-flow bisection.

## Desktop 0.3.12 (2026-09-12, latest)

- Build-identity handshake: daemon.hello now carries the workspace build id
  (git commit, protocol build.rs) and the GUI refuses + respawns any daemon
  from a different build — a leftover background service of an older install
  can no longer serve a new client (the Windows "Pairing…" hang after
  upgrading). Pair screen shows the running version (Guild v0.3.12).

## Desktop 0.3.11 (2026-09-12, latest)

- Fixes the 0.3.10 desktop pairing breakage: protocol-version handshake
  (crate-version compare desynced on every bump), webview API base
  (same-origin fetches can't work on tauri://localhost — use the paired
  server URL), legal Tauri 2.11 event names (no dots), bounded rpc_request,
  release-desktop.sh builds with tauri/custom-protocol. All platforms
  republished and signed; latest.json serves 0.3.11.

## Approval policy is user-scoped, not per-chat (2026-09-11, latest)

- Per-thread approval settings made no sense — tool trust is a property of
  the user and their bound machine, identical across conversations.
- Migration 0026: `users.approval JSONB` added; `chats.approval` (0023)
  dropped. Same guild-core ApprovalPolicy shape; NULL = server default
  (ask, read-only allowed).
- API: GET/PUT `/api/v1/me/approval` (auth.rs) replaces
  `/api/v1/chats/{id}/approval`. ChatRunner resolves the policy via
  `chats JOIN users` on the chat owner.
- Settings: Approvals moved from the "Current chat" group to "User"; no
  longer requires an open chat. Browser-verified flows pending next deploy.

## Tool frame UI polish (2026-09-11, late)

- Tool frame header keeps the request preview (search → query, fetch → URL,
  …) visible whether the frame is collapsed or expanded; preview text is no
  longer monospace.
- A running tool call pulses (`animate-pulse`) on the header line until its
  result lands; running frames no longer auto-expand (the body is empty
  until the result arrives anyway).
- `web_fetch` renders as "Browse" in the UI (wire name unchanged).
- Search/fetch expanded bodies show a pulsing "running…" line while the call
  is in flight. Verified live in the browser (search + fetch, running and
  completed states).

## Phase 2 — approvals as protocol events (2026-09-12)

Design: docs/plans/2026-09-12-approvals-design.md. Shipped and deployed:

- Approval policy: user-scoped `users.approval JSONB` (0026, was per-chat
  `chats.approval`), guild-core ApprovalPolicy semantics; NULL = server
  default (ask, read allowed). GET/PUT /api/v1/me/approval, editable from
  any client.
- ChatRunner gate in client_tool_step: allow -> unchanged; never -> denied by
  policy; ask -> durable `approval_request`/`approval_decision` thread events +
  `approval_requested`/`approval_resolved` frames, awakeable `approval:{call_id}`,
  5-min send_after auto-deny, shared `complete_approval` handler
  (first answer wins), POST /api/v1/gateway/chat/{id}/approvals/{call_id}.
- Attach replay emits ApprovalRequested for unresolved approvals.
- WebChat: pending/resolved approval cards; Settings approval selector +
  overrides editor. Excluded from model-facing history derivation.
- Browser-verified all four paths (approve/deny/never/allow) with a scripted
  executor (SSE presence + heartbeats + tool result POST).

## Context attachments — multimodal (2026-09-11, latest)

- Composer "+" attach (ChatGPT/Claude pattern): preview strip above the
  input — image thumbnails with overlay ✕, file chips with type icon +
  name + size; user bubbles render the same previews (authed blob fetch);
  inlined wire text stripped from display.
- Uploads go to object storage via POST /api/v1/chats/{id}/attachments
  (64 MiB cap); the send carries attachment_ids; the server inlines textual
  documents into the turn (80k-char cap per file) and passes image parts
  (OpenAI image_url data URIs / Anthropic base64 blocks) and audio parts
  (OpenAI input_audio, wav/mp3) ONLY when the resolved route lists the
  modality. Unsupported media stay stored for later code-execution tooling
  (by design, never dropped from the log).
- Modality capability is admin-configurable per route: model_routes.modalities
  TEXT[] (migration 0025, values image/audio/video), edited in Settings →
  Models; GET /api/v1/admin/gateway/routes returns it.
- Derivation continuity: build_model_history replays prior image/audio parts
  from a journaled-loaded media map on every turn — images persist in
  context like Codex/Claude sessions. Compaction summaries are text-only.
- Verified live: passphrase extracted from inlined .txt, 8x8 PNG identified
  as red, composer upload → preview → send → second-turn recall all pass.

## Unified settings window (2026-09-12, latest)

- Admin UI folded into the main app: a large Settings window (user menu →
  Settings) with its own sidebar — USER (Account, Appearance, Machine),
  CURRENT CHAT (Approvals), ORGANIZATION (Usage, Users, Models, Integrations,
  Registry, Releases; admin-only). Works identically in the desktop app and
  the browser; role-gated via /api/v1/auth/me (transport apiMe now returns
  role).
- Sections live in apps/desktop/src/views/settings/sections/, lazily loaded,
  using the shared admin-api helper (same session token as the chat).
- New backend endpoint: GET /api/v1/admin/gateway/routes (full route rows,
  no secrets) so Models editing is prefilled.
- The old /admin console still exists untouched during the transition; the
  desktop handoff link remains but the window is the primary surface now.

## Loading + staleness fixes (2026-09-12, latest)

- Deep links render the thread skeleton on FIRST paint — the new-thread hero
  appears only when the user explicitly creates a new thread.
- ThreadSkeleton is now conversation-shaped (skeleton bubbles/frames), not a
  spinner; all loading widgets use skeletons.
- Cache headers fixed at the source: hashed /assets/* are
  `immutable, max-age=1y`; index.html and sw.js are `no-cache` (previously
  NO cache headers at all — browsers heuristic-cached the shell, which is
  what made tabs go stale after deploys).
- Deploy freshness: the app polls the served shell every 60 s and reloads the
  tab when the bundle hash changes (never while streaming/loading). The SW
  itself was already network-first — headers were the root cause.

## Auto-compaction (2026-09-12, latest)

- **Manual Compact button removed from the UI** (and the gauge's Compact?
  hint) — compaction is server-side only: POST /compact stays for ops.
- **Threshold trigger**: before each model call, if the last request's
  tokens_in > context_window - 16384 (pi's reserve), the ChatRunner compacts
  first (shared compact_core) and continues with fresh derivation.
- **Overflow trigger**: provider errors matching pi's overflow regex port
  (crates/server/src/worker/overflow.rs, with non-overflow exclusions like
  rate-limit) compact once and retry the call exactly once per turn.
- Auto-compaction tokens are metered through the same usage path.

## Compaction + context gauge + desktop 0.3.9 (2026-09-12, later)

- **Compaction** (docs/plans/2026-09-12-compaction-design.md): on-demand via
  the composer-row Compact action or POST /gateway/chat/{id}/compact. The
  model summarizes pre-compaction history into a durable `compaction` event
  (summary, tokens_before, keep_last=4, model, usage); derivation replaces
  everything before it with summary + verbatim tail. UI: collapsed
  "Thread compacted" card. Compaction-call tokens are informational (not
  metered) — flag if quota accounting should include them.
- **Context gauge**: model_routes.context_window (0024, admin-settable,
  fallback 128k); GET /thread returns {tokens, max, model}; slim fill bar
  next to the model selector (amber >80%, red >90%, "Compact?" hint >90%).
- **Desktop 0.3.9 published** for linux/darwin-x64/darwin-arm64/windows,
  sha256-verified; updater delivers once. Ships thread events UI, thinking,
  tool widgets, approvals, compaction, gauge.

## Thread event log milestone (2026-09-12, this session)

Full redesign per `docs/plans/2026-09-12-thread-events-design.md` (grounded in
`docs/deepseek-harness-study.md`):

- **Thread = append-only `thread_events` table** (type + JSONB payload, uuid v7
  ordering). Event types: user_message, system_message, assistant_message
  (blocks: reasoning/text/tool_call in stream order + usage + model),
  tool_result (content + is_error + widget meta), compaction (reserved). The
  old messages table is DROPPED (0022); model-facing history is a derivation
  (`build_model_history` in worker/restate.rs).
- **Reasoning never dropped**: ProviderChunk::Thinking parses
  `delta.reasoning_content`; assistant turns persist a reasoning block; every
  reasoning-carrying turn replays `reasoning_content` to the model (dsh rule).
  StreamEvent::ThinkingDelta streams to clients; first frame after attach
  carries the full buffer.
- **Tool presentation**: ToolResult events carry tool-private `meta` (dsh
  presentationMeta pattern): web search cards (sources), web fetch cards
  (url/status/truncated), terminal/read/diff tags on client tools via
  ToolOutcome.meta. WebChat renders collapsible tool frames + per-tool
  widgets; reasoning blocks are collapsible "Thinking" frames.
- **Integrations**: trait gains category() (search/fetch/other); NEW superproxy
  plugin (fetch provider) with web_fetch against the superproxy gateway
  /v1/fetch; searxng emits search meta; admin API + new admin webui
  Integrations view (grouped by category, config editor).
- **API**: GET/POST /api/v1/chats/{id}/thread replaces /messages. Engine
  sessions append tool results via POST /thread (turn-join).
- Suite: 117 tests green (nextest, host services). Desktop/webui tsc+vite clean.
- Browser-verified live (agent-browser): multi-turn chat, web_search + web_fetch
  via UI, tool widgets from persisted meta after reload, reasoning frames,
  empty-sheet rendering, admin Integrations view. Hotfixes landed post-deploy:
  user turn missing from model request (derived before append), chat
  generation lock leaked on pre-turn terminal failures, turn-failure error
  logging.
- Orchestration was run via herdr panes + dagr run file (.dagr/run.json,
  gitignored); workers: store/providers/integrations/webchat/adminui/loop +
  followup T9; orchestrator did protocol base, engine-path fix, merges,
  verification. Worker panes retired after merge.

## Shipped (2026-09-12, later)

- **Tool calls survive page refresh** (client fix, server redeployed): tool
calls were always persisted, but WebChat's history rebuild filtered to
user/assistant rows only. New `msgsToBlocks()` in
`apps/desktop/src/views/WebChat.tsx` rebuilds tool chips from assistant
`tool_calls` + `tool` result rows (joined by `tool_call_id`);
`ChatMessage` in transport.ts now declares the tool fields. No migration.

## Infra (2026-09-12)

- **Default operating mode: shared host services.** Prod and tests use the
  neutral host postgres (`/srv/postgres`, :5432), host ClickHouse
  (`/srv/clickhouse`, :8123, user `ch_user`), and rustfs (:9950). No
  testcontainers; compose infra is behind the `fullstack` profile and
  stopped. Details: `docs/deploy-nuances.md` §0.
- Prod data migrated 2026-09-12 and verified live (usage 71 rows from host
  CH, releases from rustfs, pg_dump of users/chats into host postgres).
  Pre-cutover volumes (`pgdata`, `chdata`, `miniodata`) still exist as
  rollback; stale orphan cluster parked at `/srv/postgres.old-20260912`.
- `GUILD_CLICKHOUSE_USER`/`GUILD_CLICKHOUSE_PASSWORD` config keys added
  (`Config::clickhouse_client()` centralizes auth); deploy compose server
  reaches host services via `extra_hosts: host.docker.internal:host-gateway`.

## Shipped and deployed (as of 2026-09-10)

- **Server** live at `:18080` (compose stack, image rebuilt + restarted).
  Desktop **0.3.7** published for linux/darwin-x86_64/darwin-aarch64/windows
  (sha256-verified on upload; updater delivers it once — no loop). 0.3.7 is
  the daemon milestone: per-user daemon (survives client closure, shared by
  all windows + CLI verbs, only session-token route to the server), GUI
  attaches over a local socket, `engine` mode removed, `daemon.hello`/
  `daemon.shutdown` handshake, workspace version bumped to 0.2.0 for the
  handshake. Plans: `docs/plans/2026-09-10-milestone-8-daemon.md`;
  watch-items: `docs/deploy-nuances.md` §Daemon watch-items.
- **Server-owned system prompt** (also in `d370726`): the ChatRunner workflow
  builds the prompt server-side (`build_system_prompt` in
  `worker/restate.rs`) — role, client-tool guidance, web_search-only-for-
  general-knowledge, workspace path from the optional `project_dir` field on
  `ChatCompletionRequest` (forwarded by the gateway; desktop `agent_session`
  sends it). The client's `system` field stays unused for agent turns; don't
  reintroduce client-side prompts.
- **Machine-bound executor model** (commit `d370726`):
  - Chats bind to one machine (`chats.machine_id/machine_label`, migration
    0019). Desktop auto-binds itself at chat creation; web binds via
    Settings → Machine. A run executes tools ONLY on the bound machine.
  - Executor registry in `AppState`: **heartbeat-based liveness**
    (`EXECUTOR_TTL_SECS = 15`; desktop pings `/api/v1/machines/heartbeat`
    every 5s). TCP-level disconnect detection is unreliable through
    docker-proxy — do not reintroduce it.
  - Machine tools declared to the model when `client_tools` OR the chat is
    bound → web-originated turns can use the bound machine.
  - Fail fast: unbound chat → "not bound to a machine…"; bound-but-offline →
    "machine 'X' is offline…". Both verified live; the model relays them.
  - Machine watcher: a suspended tool is aborted ("bound machine 'X' went
    offline before executing it") ~20s after heartbeats stop; 5-minute
    journaled `send_after` stays as backstop. All resolution flows through
    the durable `complete_tool` shared handler (replay-safe).
  - Pending tool replay on attach: late-attaching clients receive suspended
    `ToolStarted` events and can execute/answer them.
- **Unified desktop shell**: the desktop webview runs the same `WebChat` as
  the browser over HTTP (engine token → `localStorage.guild_token`);
  AgentView retired from the surface (file kept). Admin-console handoff link
  kept. `tauri.conf.json` version must be bumped on every desktop release
  (updater compares it).
- **Infra fixes in the same commit**:
  - events SSE listener uses a **standalone PgListener connection** — the
    pool-based one leaked a pool connection per stream and exhausted the
    pool (all authenticated endpoints then hang forever). See
    `~/workspace/hanging-commands.md` Patterns 5–8; always `curl --max-time`.
  - `watch::Sender::send()` fails with no receivers (counts froze at 0) —
    any future liveness channels must use `send_replace` or heartbeats.

## Verified live (curl + browser, 2026-09-10)

Unbound fail-fast ✓ · offline fail-fast ✓ (2s turns) · suspend while machine
alive ✓ · heartbeat liveness through stream drop ✓ · death-abort ~20s ✓ ·
retry-then-fail-fast ✓ · coherent model answers ✓ · machine chip in header ✓
· Settings Machine section ✓ · attach replay of pending tools ✓.

## In flight by other sessions

- **Milestone 8 (daemon)** — session `01a08b19`, plan in
  `docs/plans/2026-09-10-milestone-8-daemon.md`. Started after `d370726`
  landed. Touches `crates/app-server/src/jsonrpc_loop.rs` (note: it contains
  a small additive `machine.info` handler returning the hostname) and
  `apps/desktop/src-tauri/src/main.rs`.

## Known gaps / next up

## Resolved 2026-09-12: Windows pairing hang (desktop)

**Root cause** (diagnosed in situ on the user's Windows box via WSL SSH + a
daemon-side trace): the GUI's reader thread did a blocking read on a
duplicated *synchronous* named-pipe handle. Windows serializes I/O on the
file object, so the concurrent first rpc write queued behind the parked read
and never ran \u2014 every fresh launch froze deterministically at its first
daemon call. Unix sockets have independent fds, which is why no local test
ever reproduced it.

**Fix** (`48f9156`, released as desktop **0.3.14**):
- Windows client is now a **tokio named-pipe client** (mirrors the daemon's
  ServerOptions side): true concurrent read/write, async handshake carrying
  build identity + daemon pid.
- A **supervisor task** owns the daemon lifecycle: pings every 20s; on
  repeated silence sends `daemon.shutdown`, then taskkills the wedged daemon
  by pid and respawns \u2014 a wedged daemon can never hang the UI again.
- `daemon.hello` reports its `pid`; `Pair` carries the raw read handle;
  `release-clients.sh` defaults BASE to `https://guild.example.com` so
  updater URLs work without the user's SSH tunnel.

**Verified end-to-end on the user's machine**: 0.3.14 silently installed,
attach/handshake/ping/session.info/machine.info all < 1ms through the new
path, and the machine registered on the server (`machines` \u2192 `WORKSTATION`) with
the session restored in the webview. Paired against the public URL directly
(no tunnel).

1. **Phase 2 — approvals as protocol events** (agreed design, not built):
   workflow requests approval → broadcast to ALL attached clients → first
   Approve/Deny wins via `complete_tool`-style answer, recorded server-side;
   `ask/allow/never` becomes a server-side chat setting editable from any
   client; approval cards in the unified UI.
2. **Desktop engine as first-class executor** (agreed, not built): engine
   sessions (`cloud.rs` / AgentView path) send no machine binding, no
   heartbeat, no client_id — engine-originated agent sessions fall back to
   the 5-min timeout for client tools and don't register as executors.
3. **Thread-list status feature** — BUILT 2026-09-14 (design
   `docs/plans/2026-09-14-thread-list-status-design.md`, migrations
   0041/0042): `chats.generating` is flipped by the ChatRunner in journaled
   steps (entry after route/quota resolution, cleared at final answer /
   uniform failure / step limit; the stale-generation sweep also clears it
   for chats whose records are dead). Unread is derived at list time
   (assistant turn newer than the (chat,user) `chat_reads` marker on a
   non-generating chat; 0042 backfills markers so pre-existing threads
   start read). Status propagates on a notify-only channel
   (`guild_chat_status`) through the events stream as `chat_status` SSE
   frames, owner-scoped; web clients consume their stream now, the desktop
   app process routes SSE by event name and forwards chat_status as a
   `chat-status` Tauri event outside the seq watermark. Sidebar rows show
   a spinner while generating, a dot when unread; mark-read fires on
   thread load and turn end for the visible open chat (hidden tabs keep
   their dot). Verified live: background turn → spinner → dot → click →
   read (UI + server agree). Watch-item: event-stream slots are
   per-user-capped (3) and stale connections through docker-proxy linger —
   repeated client reloads can 429 a tab's stream until the server
   restarts or stale connections time out.
4. **Full desktop sign-out**: currently drops only the webview token; the
   engine session persists (needs an engine logout rpc).
5. **Embedded Restate runtime for tests**: gateway chat routes through the
   Restate ChatRunner, but test_support points `restate_url` at a placeholder.
   10 integration tests are `#[ignore]`d with that reason (agent_rpc x2,
   engine_stdio, roundtrip x2, gateway_api x2, gateway_tools, quota_api,
   usage_api, web_serving) — un-ignore all of them together once tests embed
   a Restate runtime. Also: stray container health/S3 probes can land on test
   mocks via the docker-proxy listener collision; `received_requests()`
   assertions should filter on the specific path, not total count.
6. **Web (browser) clients cannot execute machine tools by design** — keep
   it that way; execution is executor-bound.
7. **Releases: move out of the API data model** (maintainer, 2026-09-11):
   releases are dev objects existing outside the app workflow — publishing
   belongs to `scripts/release-clients.sh` and object storage, not to the
   product API surface. Today artifacts still live as
   `/api/v1/releases` + `/api/v1/admin/releases` rows; future task is to
   strip them from the API (keep only public download + updater manifest
   serving, backed directly by object storage).

## Conventions to keep

- Deploy = `cd ~/guild/deploy/compose && docker compose build server &&
  docker compose up -d server` (frontends are embedded via `include_dir!`).
- Long builds/tests: `big-job` skill (systemd transient units), never
  foreground. `curl --max-time` always. `PLAN.md`/docs updated on state
  changes so sessions can compact and recover.
- Orchestration topology (maintainer, 2026-09-12): split worker agents from the
  orchestrator's own pane (`herdr pane split --current --direction right|down
  --no-focus` + `herdr pane run <id> "cd <worktree> && exec pi"`), one git
  worktree per worker; retire each pane (`herdr pane close`) once its branch
  is merged. Waits: `herdr agent get` first — `agent wait --until` only fires
  on future transitions and hangs on settled agents; never sleep-poll.
- Fast tests (2026-09-12, host-services mode): plain `cargo test` (default-members excludes
  `guild-desktop`; use `-p guild-desktop` explicitly for it — `--workspace`
  still builds it). `.cargo/config.toml` uses lld + line-tables-only
  debuginfo (changing rustflags invalidates the target cache once). Tests use
  the **host services** (no testcontainers): Postgres at 127.0.0.1:5432,
  ClickHouse at :8123, rustfs at :9950 — per-run isolated db/bucket on each.
  `Store::connect_test()` creates `test_*` databases on the host postgres
  (stale ones with no live connections are reaped on first use);
  `full_state()` gets a per-test ClickHouse db + S3 bucket on the shared
  host servers. Overrides: `GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`
  (+ `_USER`/`_PASSWORD`), `GUILD_TEST_S3_URL` (+ `_ACCESS_KEY_ID`
  /`_SECRET_ACCESS_KEY`). Suite: 38 tests ~3.5s with
  `cargo nextest run -p guild-server --features test-support`. Plain
  `cargo test` stays green and is the fallback. If a test run can't reach
  the host services, start them first (`/srv/postgres` compose up,
  `systemctl start rustfs`, `/srv/clickhouse` compose up).
- Debug session token `pi-debug-session-token-2` is extended 7 days
  (expires ~2026-09-17); revoke when no longer needed.
- Releases (maintainer, 2026-09-11) are dev objects, not API objects: they exist
  outside the app workflow and should not grow into product surface. Publish
  via `scripts/release-clients.sh` only; do not build product features around
  the `/api/v1/releases` data model beyond serving downloads + the updater
  manifest.
