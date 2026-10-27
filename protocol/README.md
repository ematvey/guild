# protocol

The wire, in one place. Nothing outside this directory decides a frame shape.

## What is here

- `socket.schema.json` — the member and machine socket: every frame, its
  fields, and its presence rules. Derived from `crates/protocol/src/ws.rs`.
- `rest.schema.json` — the data-transfer types that cross the TS/Rust
  boundary over HTTP. Derived from `crates/protocol/src/api.rs` and
  `crates/protocol/src/registry.rs`.
- `fixtures/<schema>.<Root>.json` — one example per variant of `$defs.<Root>`
  in `<schema>.schema.json`. Each file is a JSON array.
- `check.mjs` — validates every fixture against its schema and requires a
  fixture for every variant of a tagged union.

The fixtures are the executable form of the schema. The Rust suite
deserializes every one of them; the TypeScript suite parses them. A field
renamed on one side fails that side's test.

## Presence is the contract

`absent` and `null` are different. A field the Rust sender omits must stay
omitted; a field it always serializes (even as `null`) must stay present.
`additionalProperties: false` is deliberate: a new field is a contract change.

## No generator

The types are hand-written on each side, from these schemas:

- `packages/wire` — TypeScript, shared by the server and the desktop.
- `crates/protocol/src/ws.rs`, `api.rs`, `registry.rs` — Rust.

Nothing generates TypeScript from Rust.

## Run the check

```sh
node protocol/check.mjs
```

`scripts/check.sh` runs it as the `protocol` check.
