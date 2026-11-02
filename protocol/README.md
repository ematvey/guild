# protocol

The wire, in one place. Nothing outside this directory decides a frame shape
that crosses a boundary we do not own. A wire between two modules of this
server stays beside its code: the sandbox frames and their value encoding are
in `apps/server/src/sandbox/protocol.ts`, because the sandbox is an
implementation detail of the server and both ends ship together.

## What is here

The schemas are the contract. The Rust types (`crates/protocol/src`) and the
TypeScript types (`packages/wire/src`) are hand-written from them, and both
sides are tested against the fixtures here.

- `socket.schema.json` — the member and machine socket: every frame, its
  fields, and its presence rules. Rust: `crates/protocol/src/ws.rs`.
- `rest.schema.json` — the data-transfer types that cross the TS/Rust
  boundary over HTTP: the sidebar rows, the account and pairing shapes, the
  machine registry, the turn submission, the thread events and the registry
  manifests. Rust: `crates/protocol/src/api.rs` and
  `crates/protocol/src/registry.rs`.
- `rpc.schema.json` — the line-delimited JSON-RPC 2.0 envelope between the
  desktop UI and the engine, and over the local CLI socket. Rust:
  `crates/protocol/src/rpc.rs`.
- `fixtures/<schema>.<Root>.json` — one example per variant of `$defs.<Root>`
  in `<schema>.schema.json`. Each file is a JSON array.
- `check.mjs` — validates every fixture against its schema, requires a
  fixture for every variant of a tagged union, compares every `$defs`
  entry with its TypeScript declaration, and compares the schemas with the
  last shipped client's (see below).

Each file has a root index: an object whose properties are the `$defs`
names. A payload is validated against a `$defs` entry, never against the
root. The index exists so a schema viewer, which draws the root, can list
every type. The check fails when the index and `$defs` disagree.

The fixtures are the executable form of the schema. The Rust suite
(`crates/protocol/tests/fixtures.rs`) deserializes every one of them and
re-serializes it back to the same JSON; the TypeScript suite parses them. A
field renamed on one side fails that side's test.

`check.mjs` reads the TypeScript declarations in `packages/wire/src` with the
compiler and compares them with every `$defs` entry, not only the fixture
roots. It fails when:

- a definition has no TypeScript declaration of the same name. A named
  variant of a tagged union is compared as a member of that union's
  declaration; any other exception is listed, with its reason, in
  `UNDECLARED_DEFS_ALLOW`;
- a union's variants, an enum's values, or an object's property names
  differ, or a property is required on one side and optional on the other;
- a property's type differs. Each side's type is reduced to a shape —
  primitives, named types, arrays with their element shape, inline objects
  with their properties (compared recursively) and maps with their value
  shape. A named type is compared by name: the schema's `$defs` name against
  the TypeScript type name, so `Chat[]` against `Project[]` fails.
  `REF_ALIASES` maps a schema name to a TypeScript name where the two
  differ. An alias of a primitive (`Uuid`, `DateTime`) is inlined on both
  sides. `Json`/`unknown`/an empty schema match anything;
- a TypeScript type reference is not declared in `packages/wire` (listed
  exceptions: `UNRESOLVED_TS_ALLOW`), or a `$ref` does not resolve.

`KNOWN_DRIFT` lists, with reasons, mismatches the gate tolerates until the
two sides are reconciled.

What is not checked:

- **Rust against the schema, beyond the fixtures.** Nothing reads the Rust
  types statically; the fixture round trip is the only Rust check. Sixteen
  `WsServerMsg` variants carry `serde_json::Value` payloads: fifteen display
  frames the engine does not read (the thread, project, machine, agent,
  skill and chat-tree lists, `thread_events`, `thread_state`, `org_event`,
  `subagent_tree`, `agent_run`, `chat_row`), and `machine_request`, whose
  payload the engine decodes per `op`. For those frames Rust checks only the
  tag and the outer fields; their payload shape is held by the schema, the
  fixtures and the TypeScript comparison alone.
- **Formats and value constraints** (`format: uuid`, `minimum`, patterns)
  against TypeScript: TypeScript has no such types.
- **Tuples**: a TypeScript tuple is read as an array of anything.

## Older clients keep working

An installed client was built against the schemas of its release. Each
client release is tagged `client-v<version>` by `scripts/release-clients.sh`,
and `check.mjs` loads `socket.schema.json` and `rest.schema.json` from the
newest such tag and fails on a change that client cannot survive:

- **server → client** (`ServerFrame` and everything it reaches; every REST
  type that is not a `*Request` body): a removed variant, property, enum
  value or definition; a changed type or `const`; a required property that
  became optional.
- **client → server** (`ClientFrame` and the `*Request` bodies): a newly
  required property; a removed variant, enum value or definition; a changed
  type.

Adding an optional request property, a new response property, a new
variant or a new enum value passes. `rpc.schema.json` is not compared: the
UI and the engine ship in one binary.

With no `client-v*` tag reachable (a fresh or shallow clone, or no git
checkout) the comparison does not run: the check prints a loud warning and
passes, and fails when the `CI` environment variable is set. Fetch the tags
(`git fetch --tags`, or `--unshallow --tags` on a shallow clone) before
trusting a pass. `scripts/release-clients.sh` runs the check before it
builds and pushes the new tag to `origin`, so the baseline is the commit a
shipped client was built from.

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
