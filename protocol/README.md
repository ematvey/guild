# protocol

The wire, in one place. Nothing outside this directory decides a frame shape.

## What is here

- `socket.schema.json` — the member and machine socket: every frame, its
  fields, and its presence rules. Derived from `crates/protocol/src/ws.rs`.
- `rest.schema.json` — the data-transfer types that cross the TS/Rust
  boundary over HTTP: the sidebar rows, the account and pairing shapes, the
  machine registry, the turn submission, the thread events and the registry
  manifests. Derived from `crates/protocol/src/api.rs` and
  `crates/protocol/src/registry.rs`.
- `rpc.schema.json` — the line-delimited JSON-RPC 2.0 envelope between the
  desktop UI and the engine, and over the local CLI socket. Derived from
  `crates/protocol/src/rpc.rs`.
- `sandbox.schema.json` — the sandbox RPC wire between the server's
  `SandboxExecutionEnv` and the in-sandbox agent: one JSON frame per line,
  tagged by `t`. Derived from `apps/server/src/sandbox/protocol.ts`.
- `fixtures/<schema>.<Root>.json` — one example per variant of `$defs.<Root>`
  in `<schema>.schema.json`. Each file is a JSON array.
- `check.mjs` — validates every fixture against its schema and requires a
  fixture for every variant of a tagged union.

The fixtures are the executable form of the schema. The Rust suite
deserializes every one of them and re-serializes it back to the same JSON;
the TypeScript suite parses them. A field renamed on one side fails that
side's test. `check.mjs` also requires an `@guild/wire` declaration for every
fixture root of the three `@guild/wire` schemas, so a type cannot exist on
the wire and be missing from the TypeScript side.

## Presence is the contract

`absent` and `null` are different. A field the Rust sender omits must stay
omitted; a field it always serializes (even as `null`) must stay present.
`additionalProperties: false` is deliberate: a new field is a contract change.

## No generator

The types are hand-written on each side, from these schemas:

- `packages/wire` — TypeScript, shared by the server and the desktop:
  `rest.ts`, `types.ts` (socket), `rpc.ts`.
- `crates/protocol/src/ws.rs`, `api.rs`, `registry.rs` — Rust.

Nothing generates TypeScript from Rust.

## Run the check

```sh
node protocol/check.mjs
```

`scripts/check.sh` runs it as the `protocol` check.
