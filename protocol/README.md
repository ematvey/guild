# protocol

The wire, in one place. Nothing outside this directory decides a frame shape.

## What is here

- `socket.schema.json` — the member and machine socket: every frame, its
  fields, and its presence rules. Derived from `crates/protocol/src/ws.rs`.
- `fixtures/socket.server.json`, `fixtures/socket.client.json` — one example
  per variant. They are the executable form of the schema: the Rust suite
  deserializes them, the TS suite parses them, and `check.mjs` validates them.

## Presence is the contract

`absent` and `null` are different. A field the Rust sender omits must stay
omitted; a field it always serializes (even as `null`) must stay present.
`additionalProperties: false` is deliberate: a new field is a contract change.

## No generator

The types are hand-written on each side, from this schema:

- `packages/wire` — TypeScript, shared by the server and the desktop.
- `crates/protocol/src/ws.rs` — Rust.

Nothing generates TypeScript from Rust. The fixtures hold the two sides
together: a field renamed on one side fails that side's fixture test.
