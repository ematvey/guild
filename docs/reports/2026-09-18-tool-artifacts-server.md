Done. Server-side tool artifacts are implemented, tested (395 tests pass), and committed on `feat/ta-server` in 3 commits.

## What I built

- **Storage**: `tool_artifacts` table (migration `0052`), store with create-or-reuse insert (`ON CONFLICT DO NOTHING`), org-scoped `get`, `list_for_chat`; download + list endpoints (`GET /api/v1/tool_artifacts/{id}`, `GET /api/v1/chats/{chat_id}/tool_artifacts` — returns a bare JSON array) registered next to attachments.
- **Spill**: one choke point inside the journaled tool-execution run in `server_tool_step` (`crates/server/src/worker/spill.rs` holds the logic). Content over 64 KiB (`SPILL_THRESHOLD_BYTES`) or a tool-carried `ToolOutcome.artifact` payload (spilled always) becomes a row + rustfs bytes; the model sees pointer text; the event gets `artifact_id` and the artifact meta card. The spill rides the journaled run (replay restores the recorded result, no re-upload), and creation is additionally idempotent: uuid v5 over `chat_id + call_id` (replay resolves to the same row).
- **Producers**: `ToolOutcome.artifact {filename, content_type, bytes}` added to both the guild-core and integration shapes (all ~50 constructors updated); google_workspace `api` cap 12,000 → 1 MiB; `gmail_get_message` now lists attachment parts (filename, mime, attachment id); new `gmail_get_attachment` decodes base64url via a new bytes variant of `decode_body_part` and returns the artifact payload. The server-side guild-core tool loop (`http/agents.rs`) also spills tool-carried artifacts via the hooks.

## Contract for the client/UI lanes (exact shapes)

- `ThreadEvent::ToolResult.artifact_id: Option<Uuid>` (serde-default, already in protocol).
- Spilled event `meta` keys (exact): `card:"artifact"`, `id`, `filename`, `content_type`, `size_bytes`, `path` where `path` = `.guild/artifacts/{chat_id}/{filename}`. Note: I merge the artifact keys over the tool's existing meta (e.g. the api tool's `status` rides along) and claim `card` — not a full replacement.
- Pointer text: `Tool "{name}" returned a large result saved as {filename} ({N KiB} — {n} bytes, {mime}).` then for text mimes `First 2 KiB of {N} KiB; full result at {path}:` + excerpt; binary mime just gets `Full result at {path}.`

## Tests

Store CRUD/org-scoping, deterministic id + create-reuse, spill e2e against rustfs (idempotence, collision id-prefix), endpoint round-trip with a directly-inserted row (404 on foreign org), spill unit tests (threshold, excerpt/binary shape, meta keys, mime classification), gmail base64url + attachment-part fixtures. Full suite: `cargo test -p guild-server --features test-support -p guild-core -p protocol` → 395 passed, 0 failed.

## Deviations / notes

- `agents.rs` (guild-core tool loop) spills artifact payloads only — no threshold spill there, per spec (local-class tools keep inline caps); its event log carries the pointer while the in-flight model history keeps the inline text.
- Auto tools (`list_tools`/`guide`) don't spill.
- I created an empty untracked `apps/desktop/dist/` in this worktree so the server crate compiles (`include_dir!` panics without it); the desktop lane is untouched.
- No deploy, no PLAN.md changes, other crates untouched, per scope.
