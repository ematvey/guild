# protocol

The wire, in one place. Nothing outside this directory decides a frame shape
that crosses a boundary we do not own. A wire between two modules of this
server stays beside its code: the sandbox frames and their value encoding are
in `apps/server/src/sandbox/protocol.ts`, because the sandbox is an
implementation detail of the server and both ends ship together.

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
- `fixtures/<schema>.<Root>.json` — one example per variant of `$defs.<Root>`
  in `<schema>.schema.json`. Each file is a JSON array.
- `check.mjs` — validates every fixture against its schema, requires a
  fixture for every variant of a tagged union, and compares every named
  object and union with its TypeScript declaration.

Each file has a root index: an object whose properties are the `$defs`
names. A payload is validated against a `$defs` entry, never against the
root. The index exists so a schema viewer, which draws the root, can list
every type. The check fails when the index and `$defs` disagree.

The fixtures are the executable form of the schema. The Rust suite
deserializes every one of them and re-serializes it back to the same JSON;
the TypeScript suite parses them. A field renamed on one side fails that
side's test. `check.mjs` reads the TypeScript declarations with the compiler
and fails when a fixture root has no declaration, when a property name
differs, or when a required field is optional on one side and required on
the other.

## Presence is the contract

`absent` and `null` are different. A field the sender omits must stay
omitted; a field it always serializes (even as `null`) must stay present.
`additionalProperties: false` is deliberate: a new field is a contract change.

A request follows its reader, a response follows its writer:

- A request DTO lists in `required` only what the server cannot deserialize
  without. `CreateProjectRequest.name` is optional because the server reads
  an absent field as `None`.
- A response DTO lists in `required` every field the server always
  serializes. An `Option` that serializes as `null` is required and nullable.

## Cross-schema references

Each schema has an `$id` of `https://guild.local/protocol/<name>.schema.json`.
A `$def` may reference another schema by that id: the socket frames point at
`rest.schema.json#/$defs/Chat` and `#/$defs/ThreadEventRow`, so one type has
one home. `check.mjs` registers every schema with Ajv before it compiles, so
a cross-file `$ref` resolves.

`Json` is reserved for a value whose shape the protocol does not fix: tool
arguments, an org event payload, an RPC parameter. A frame payload that has
a fixed shape gets a `$def`, even when it rides in an array.

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
