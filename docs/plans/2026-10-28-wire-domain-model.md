# Wire domain model before the wide release

Date: 2026-10-28. Status: **analysis not started**. Scope: the client↔server
wire — `protocol/`, `packages/wire`, `crates/protocol` — and the client code
that consumes it.

## Why

The wire grew by migration. The Rust server's types were transcribed to
TypeScript, then the frame payloads were typed one at a time. The result
works, but it carries the history: dead variants, one concept with two
shapes, and `Json` where a shape exists.

The wide release makes every later change expensive: web, desktop and mobile
clients will be installed and out of step. So the break happens once, now,
before that release, and after an analysis of what the domain actually is.

This plan records the evidence. It does not decide the model.

## Method

The analysis comes first. The edits follow from it.

1. List the concepts that cross the wire. For each: who creates it, where it
   is stored, who reads it, and how long it lives.
2. Name one owner and one canonical shape per concept. A concept with two
   shapes needs either a written translation or a merge.
3. Check the list against the committed model in
   `scripts/coherence/models/` and against `scripts/coherence/check.py`.
4. Only then decide the break, and write it as a version step.

Deliverables:

- a concept table: name, definition, owner, representations, lifecycle;
- the merges and the deletions, each with the reason;
- the version step, and the client window it supports.

## Questions the analysis must answer

- Is `Chat` one concept or two: the conversation, and the sidebar row? The
  `type` / `archived` / `deleted` fields are the open edge.
- Is a thread event one concept or two: the durable record, and the live
  stream? Where exactly is the delta/record line?
- Which wire values are opaque by nature, and which are `Json` by accident?
- Does the transport own a type, or the domain? `ThreadEvent` lives in the
  REST schema and rides the socket.
- What are a run, a turn, a step and a generation? Each appears in several
  shapes today.
- Which frames does the server still send, and which are stale?

## Recorded findings

Evidence, not decisions. Line numbers are from 2026-10-28.

1. **Five of eleven `StreamEvent` variants have no producer.** `idle`,
   `tool_call_delta`, `tool_call_done`, `approval_requested` and
   `approval_resolved` are declared in `protocol/socket.schema.json` and
   handled in `apps/desktop/src/lib/thread-reducer.ts`, and no server code
   emits them. Approvals reach the client as durable `approval_request` and
   `approval_decision` rows on `thread_events`
   (`apps/server/src/harness/approvals.ts:402`).
2. **One engine event is mapped twice.** `pi.tool-result` builds the durable
   `tool_result` in `apps/server/src/chats/projection.ts:184` and returns
   `void`; `apps/server/src/chats/bridge.ts:426` then rebuilds a thinner
   `tool_completed` frame from the same entry. The durable event adds
   `turn`, `step`, `meta` and `images`.
3. **`error` and `turn_error` are the same concept.** The stream variant adds
   `code` (`apps/server/src/chats/bridge.ts:313`); the durable one does not.
4. **`Chat` had two builders and one reduced shape.** `chatWire` and
   `chatRow` are now one function in `apps/server/src/chats/chat-wire.ts`,
   and every chat response carries the list row.
5. **Twelve fields are `Json`.** Each needs a verdict: opaque by nature, or a
   missing type. The list: tool `arguments` and `meta`, tool `parameters`, a
   field `default`, an RPC `params` / `result` / `data` / event `payload`, a
   machine RPC `payload`, a trigger `trigger_config`, an org event `payload`.
6. **The schemas had no root.** Each is now a `$defs` bag plus a root index,
   so a schema viewer can list the types. The check fails when the index and
   `$defs` disagree.
7. **The compatibility rule exists in `PLAN.md`.** An installed client keeps
   working across core releases. There is no gate yet.

## The break

Allowed before the wide release: remove a variant, rename a field, merge two
types, delete a frame.

Not allowed after it without a version step.

The rule that makes this safe for a reader: ignore an unknown field, ignore
an unknown variant, never fail a frame for what it does not know.

## Out of scope

- The sandbox wire: a server implementation detail, both ends ship together.
- The JSON-RPC envelope: the desktop and the engine release together.
- A compatibility gate: the rule is recorded; the mechanism comes after the
  model, not before it.

## Open

- The mobile client's supported version window.
- Whether `StreamEvent` survives as a type, or becomes a projection of
  `ThreadEvent`.
