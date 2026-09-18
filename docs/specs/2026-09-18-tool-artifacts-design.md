# Tool artifacts — spilled large tool results

Design agreed with maintainer 2026-09-18 (grilling session). Motivation: the
google_workspace `api` tool caps its response text at 12,000 chars, so
pulling a 12 KB XLSX attachment through Gmail's base64url JSON (~16 KB of
payload) arrives cut mid-stream; there is also no binary path from a tool
result to a file on the user's machine. Tool results are today single text
strings inline in the `thread_events.payload` jsonb — big results either get
truncated before persisting or bloat history verbatim.

## Primitive

One mechanism: a tool result too large for history is **spilled** into a
first-class artifact (row + object storage bytes). The model gets a short
pointer; the user gets a download card; the client machine materializes the
bytes as a real file on demand.

## Storage

- New table `tool_artifacts`:
  `id, chat_id, org_id, filename, content_type, size_bytes, object_key,
  tool_name, call_id, created_at`.
  FK cascade on chat (mirrors `attachments`), unique `object_key`.
- Bytes in rustfs S3 with the attachments layout
  `object_key(org_id, id, filename)`.
- Download endpoint `GET /api/v1/tool_artifacts/{id}`, member-auth, org
  scoped — symmetric to `GET /api/v1/attachments/{id}`. Clients never hold
  S3 credentials; the local engine fetches through this endpoint.
- **No server-side cleanup for now** (TODO): artifacts live indefinitely,
  like user attachments.
- Replay determinism: the artifact id is journaled before the fetch/write
  completes, so a Restate replay reuses the recorded id and never re-uploads.

## Event shape

`ThreadEvent::ToolResult` (crates/protocol/src/api.rs) gains an optional
typed field, serde-default, absent on old events:

- `artifact_id: Option<Uuid>` — resolves through `tool_artifacts`; the event
  never carries the storage key.

Spilled `content` (model-facing text):

- text mime: materialized path + size/mime line + first 2 KiB head excerpt,
  explicitly marked ("first 2 KiB of N KiB; full result at <path>").
- binary mime (XLSX/PDF/ZIP): path + size + mime only.

Not in `meta` — that field stays UI-opaque render intent.

## Spill trigger

- Single choke point in the Restate worker where `ToolOutcome` becomes an
  event: spill when serialized content > **64 KiB** (global threshold).
- Per-tool caps become **storage ceilings**, not history protection:
  http_call keeps its 1 MiB ceiling (now spills instead of truncating), the
  google_workspace `api` tool's 12K can rise to its ceiling.
- **Server-side tools only.** Local tools (`read_file`, `shell`) keep their
  inline caps — their output already has a local copy the model can re-read
  with offset/limit.

## Access: lazy materialization on the client machine

- Model-facing path: `<workdir>/.guild/artifacts/<chat_id>/<filename>` — a
  real workspace path, readable by both `read_file` and `shell` with no
  special knowledge. Filename collisions inside a chat get an id-prefix.
- The engine's fs layer fetches from the download endpoint on first touch if
  the file is not materialized yet (lazy pull).
- Opportunistic background prefetch: while the producing chat has a
  connected member socket, the engine materializes right after journaling,
  so the model's first read is usually local. Offline machines fall back to
  fetch-on-touch; a read before materialization fails with an explicit
  "will fetch when online" rather than a dead path.
- Local materialized copies live indefinitely (no eviction for now).
- Exec policy: `.guild/artifacts/` is inside the workspace scope, so the
  sandbox already allows reads there.

## Wire/UI identifier

`guild://tool_artifacts/<id>/<filename>` — the scheme names the resolver
(Guild owns the namespace); it appears in event metadata and drives the UI
download card. Never shown to the model as a path; never an OS-registered
handler.

## Out of scope (decided)

- Compaction: pointers may fall out of model history; no special handling —
  artifacts and UI downloads survive regardless.
- Spilling local-tool outputs.
- Server-side artifact TTL/cleanup (TODO marker only).
- Binary write path for local `write_file` (unchanged).

## Follow-up producers on the same primitive

- `gmail_get_attachment`: decode the Gmail part's base64url body data with
  the part's filename/mime and emit bytes through the spill primitive
  (`decode_body_part` already exists in google_workspace.rs). The generic
  `api` tool then no longer needs to carry attachment payloads.
