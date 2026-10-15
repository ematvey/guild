# TODO

Future tasks. Newest on top. Move items to PLAN.md entries when they land.

## Codemode: history access + presentation

### 1. Switch to codemode-only tool exposure

- Set `codemode.mode: "only"` so active tools are hidden from the model and
  reachable only through codemode scripts.

### 2. Programmatic thread-history access inside codemode

- Expose the full thread to codemode scripts: an array (tool-backed) of all
  past messages with their JSON structure.
- Backing should be real: scripts pull messages from the server, not from a
  local snapshot.
- Likely a set of tools rather than one: search/filter the history of the
  current thread (by role, time range, text query, pagination/cursors).
- Implementation shape: extension tool(s) with codemode exposure; results
  structured (`outputSchema`) so scripts get JSON, not text.

### 3. Global search across all threads

- Search across every thread the current user has access to (scoped to the
  user's permissions — never cross-account).
- Same tool family as (2): text query over all threads, return thread id,
  message location, and context snippets for the model to drill into.

### 4. Remake the codemode tool widget rendering

- Extract the code (script source) from the codemode tool call props and
  render it as proper code: syntax highlighting (JS/TS), formatting, and the
  usual code-block presentation in the chat UI.
- Target look: like pi (prime-agent) renders codemode calls.
- Lives in the desktop client chat views (`apps/desktop/src/views/...`).
