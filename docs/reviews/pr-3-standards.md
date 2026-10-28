# Standards review — PR 3 (develop vs master cacb9d96, HEAD 1b134294)

## Hard violations of documented standards

**1. `jsonbText` / `recordJsonText` do not sanitize property names.**
`apps/server/src/platform/domain/text.ts`:
```ts
JSON.stringify(value, (_key, item) =>
  typeof item === "string" ? sanitizeText(item).toWellFormed() : item);
```
A JSON replacer never visits keys. PLAN (`Records are JSON text…`) says
"U+0000 cannot enter a record", and README says `jsonbText` owns the JSON
text. A key that holds U+0000 still reaches `jsonb` and still fails with
`22P05`. `encodeValue` in `sandbox/protocol.ts` has the same gap for keys.

**2. The sanitizer breaks the command idempotency contract.**
`apps/server/src/platform/store/turn_commands.ts` stores
`jsonbText(request)`, then compares the stored row with the raw request:
```ts
if (… || !deepEq(row.request, request)) {
  throw new ApiError(409, "command_id_conflict", …);
```
A retry whose request holds U+0000 or a lone surrogate never equals the
sanitized row, so the server answers a false 409. The file comment states
the row "keeps the gateway's idempotency contract". This breaks it.

**3. Two wire comments state a rule the repo retired.**
`apps/server/src/chats/chat-wire.ts:14`: "Field order is wire-pinned: it
follows the Rust struct serialization order." PLAN and `protocol/README.md`
say presence is the contract, not byte order (`docs: the wire contract is
presence-compatible, not byte-exact`). `apps/server/src/hub/workspace.ts:62`
says "Alphabetical key order, same reason as the chat rows"; the chat rows
are no longer alphabetical, so the comment is false.

**4. History narration in code comments.** AGENTS.md: "Code comments
describe what code is and does now — no history narration."
- `chat-wire.ts:18`: "Old chats stored the raw machine id as their label…"
- `thread-events.ts:10`: "Events written by the OLD Rust server carry the
  same shapes; the renderer normalizes both eras…"

**5. The NUL regression test does not use a NUL.** See finding 4 below.

## Baseline smells (judgement calls)

- **Middle Man** — `apps/server/src/hub/workspace.ts`:
  ```ts
  function chatRow(ctx: PlatformContext, chat: ChatListRow): Chat {
    return chatWire(ctx.hub, chat);
  }
  ```
  Call `chatWire` at the two sites; the PLAN goal is one builder.
- **Middle Man / weak type** — `apps/server/src/hub/protocol.ts`:
  ```ts
  export function streamEventWire(event: StreamWireEvent | unknown): string {
    return JSON.stringify(event);
  }
  ```
  `| unknown` absorbs the union, so the parameter type does nothing. The
  function is a wrapper over `JSON.stringify`.
- **Duplicated Code (dead condition)** — `apps/server/src/lib/thread-reducer.ts`:
  ```ts
  const queued = row.event.type === "user_message" ? queuedFieldsOf(row.event) : {};
  if (!!b.queued === (row.event.type === "user_message" && row.event.queued === true) …
  ```
  The guard `row.event.type !== "user_message"` already returned, so the
  repeated test is always true.
- **Duplicated work** — `packages/wire/src/parse.ts` parses the frame text
  twice: once in `tagOf`, once in `parseServerFrame`.

## Copilot findings

1. **Unsupported JSON property names break database writes — REAL.**
   The replacer in `text.ts` receives only values. Keys with U+0000 or a
   lone surrogate pass through unchanged into `jsonb`, and Postgres rejects
   them. Same gap in `encodeValue`.
2. **Sanitization causes false command conflicts — REAL.** `TurnCommandStore`
   stores `jsonbText(request)` and then compares `deepEq(row.request,
   request)` against the raw input. Any NUL or lone surrogate makes the
   equality fail and returns a false `command_id_conflict` on a valid retry.
3. **Sanitizing outgoing call arguments loses data — REAL.**
   `Connection.call` sends `args.map(encodeValue)`, and `encodeValue` runs
   `sanitizeText` on every string. A `write`/`exec` argument that carries
   U+0000 arrives at the sandbox as U+FFFD, so binary content is corrupted
   on the client-to-agent path, not only on results.
4. **The NUL fixture does not use an actual NUL — REAL.**
   `context-usage.test.ts` inserts `"PK\\u0000binary"`. In the JS source
   that is the literal characters `\u0000`, not U+0000, so the stored
   record is valid JSONB and the test never exercises the bug. Use
   `"PK\u0000binary"`.

VERDICT: CHANGES
