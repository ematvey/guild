# Tool artifacts — client lane report (feat/ta-client, 2026-09-18)

Commits: `1b3f83a` (guild-core), `4ac9fbd` (app-server wiring).

## What was built

**guild-core — `crates/guild-core/src/tools/artifacts.rs`**

- Path contract: `<workdir>/.guild/artifacts/<chat_id>/<filename>`.
  `parse_artifact_path` (lexical, works pre-materialization), `scan_text`
  (pointer text inside free text), `scan_args` (recursive tool-args scan,
  dedup), `model_path`, `write_bytes` (creates dirs).
- `ArtifactIndex`: chat_id + filename → artifact id, built from
  `ThreadEvent::ToolResult` events carrying `artifact_id` +
  `meta.card = { card: "artifact", filename, … }`.
- `ArtifactFetcher` trait (fetch bytes / thread events) — implemented over
  the cloud client in app-server, faked in tests.
- `materialize`: skip if file exists (no eviction — materialized copies live
  indefinitely); unknown path → rebuild index from the chat's thread log;
  fetch + write.
- `ToolRegistry` gained optional artifact hooks (`with_artifacts`). Before
  any tool runs, referenced artifact paths materialize. `read_file` fails
  with the explicit text `artifact not materialized; will be fetched when
  the machine is online: <path> (<reason>)`; other tools (e.g. `execute`)
  materialize best-effort and never hard-fail on a missed pull.

**app-server**

- `cloud.rs`: `fetch_tool_artifact` (GET /api/v1/tool_artifacts/{id},
  bearer, 30 s cap, 404 → `CloudError::NotFound`) and `thread_events`
  (GET /api/v1/chats/{id}/thread → typed `Vec<ThreadEvent>`, malformed rows
  skipped).
- `artifacts.rs` (new): `CloudArtifacts` fetcher, `registry_hooks`,
  `spawn_prefetch_on_content` (live stream), `spawn_thread_sync_prefetch`
  (agent start).
- Wiring: `Shared.artifacts` is one process-wide `ArtifactIndex`.
  - `agent.start`: registry gets hooks; thread-log sync + prefetch of every
    missing artifact spawns in the background before the run.
  - Live turn: `GatewayTurn`'s stream filter reacts to
    `StreamEvent::ToolCompleted` — pointer paths found in the result text
    spawn fire-and-forget materialization (same-turn prefetch; the model's
    read within the same run hits a local file when the pull wins the race).
  - `tool.run` RPC: same hooks.

**Scope check (task 1)**: `.guild/artifacts/...` resolves through
`resolve_scoped`/`resolve_scoped_in` both when the file exists and when it
doesn't (the missing-tail fallback canonicalizes the nearest ancestor and
rejoins) — nothing blocks it. Test: `artifacts_subtree_is_inside_read_scope`.

## Test results

- `cargo test -p guild-core -p protocol`: all green (58 + provider/protocol
  suites; 15 new artifact tests: parsing, scanning, index, materialization,
  registry integration, scope).
- `cargo test -p guild-app-server` **blocked, not by this lane**: the
  dev-dependency `guild-server` does not compile in this worktree —
  `crates/server/src/http/agents.rs:383` and
  `crates/server/src/worker/restate.rs:2184` construct
  `ThreadEvent::ToolResult` without the new `artifact_id` field (protocol
  commit 166b32d), plus the pre-existing `include_dir` dist error in
  `http/web.rs`. Server lane needs to land its branch. Three wiremock tests
  for the new endpoints are written in `cloud.rs` and will run once that
  compiles.

## Deviations / notes

- **Live prefetch source**: today's `ToolCompleted` stream frame carries
  `call_id/name/content/is_error` only — no meta, no artifact id. Prefetch
  therefore parses the relative `.guild/artifacts/…` pointer out of the
  result content (per the spec's spilled-content shape) and resolves ids via
  a thread-log sync. If the server lane later attaches `meta.card` to
  `ToolCompleted`, switch the hook to read the card directly and drop the
  text heuristic.
- WSL workdirs: materialized writes go through plain fs at the
  `\\wsl.localhost\…` UNC path (9P); reads inside the distro see the file
  live. Same transport the file tools already use.
- Path→id collisions inside a chat: last event wins in the index; the
  server's id-prefixed filenames on collision keep entries distinct.

## For the UI lane

- Nothing new to render: artifact cards still arrive via thread events
  (`meta.card`, `artifact_id`) exactly as specced.
- Materialized files appear under the chat's project workdir at
  `.guild/artifacts/<chat_id>/<filename>`; they are never cleaned up.
- The engine may briefly return the explicit "artifact not materialized;
  will be fetched when the machine is online" error on `read_file` when the
  machine is offline — surface it as a normal tool error card.
