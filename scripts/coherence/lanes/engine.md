# Lane: engine

## What you are doing

You are one of six read-only inspectors sweeping the Guild repo for
decoherence. The orchestrator has mapped 63 concepts and 124 files. Your lane
covers the 26 files below that nobody has read yet.

Area: the Rust local engine: the vendored codex crates, the app-server modules, and the shared protocol and core crates.

## Hard rules

- **Read-only.** Do not edit, delete, move or format any source file. Do not
  run builds or tests that write. Do not touch git.
- Write only these two files:
  - `scripts/coherence/models/engine.json` — your model fragment.
  - `scripts/coherence/lanes/engine.report.md` — your findings.
- Do not edit another lane's fragment, another lane's report, `floor.json`,
  `check.py`, or the shared `findings.md`.
- Follow `~/workspace/memories/INSTRUCTIONS.md` for writing style: short
  sentences, plain words, no history narration in comments you propose.

## Phase A — read every file in your lane

Read each file below in full. For each one, answer:

1. What nouns does it store, move or report on?
2. What verbs does it own, and which noun does each verb belong to?
3. Which existing concept does it carry (see `scripts/coherence/models/*.json`)?
4. Does it carry a noun that has no concept yet?

Do not start with grep. Start with reading. Then grep to confirm.

## Phase B — extend the model

Write `scripts/coherence/models/engine.json` in the shape documented in
`scripts/coherence/README.md`:

- one record per concept, with `id`, one-sentence `definition`, one
  `canonical` home, `types`, `aliases`, `representations`, `translations`.
- If a file carries an existing concept, do **not** duplicate the record.
  Add a `representation` entry to your own fragment under a new `attaches`
  entry instead:

```json
"attaches": [
  { "where": "apps/server/src/agents/tree.ts", "concept": "agent", "role": "domain" }
]
```

- If a file carries no concept (a barrel, a config, a presentational view),
  add it to `no_concept` with one of the fixed reasons:
  `presentational`, `infrastructure`, `barrel`, `types-only`, `style`.
- A type under a model root that carries no concept goes in
  `types_no_concept` with the same reasons.
- Every path you write must exist. Every role you use must be one of
  `domain`, `wire`, `event`, `db`, `ui`, `report`, `style`.

Then run:

```bash
python3 scripts/coherence/check.py model
python3 scripts/coherence/check.py coverage
```

Fix the problems that name **your** fragment. Ignore problems in other
lanes; report them in your report instead.

## Phase C — find decoherence

Look for the seven patterns (README.md, "Phase C" in
`.agents/skills/decoherence-fix/SKILL.md`):

alias collision, translation gap, no canonical home, duplicate copy,
unowned seam, unmodeled type, boundary mismatch.

Prefer evidence over impression: name the file and line for both sides of
every claim. If you suspect a duplicate, show both definitions.

## Phase D — write the report

`scripts/coherence/lanes/engine.report.md`:

```
lane:       engine
read:       <n> files, <list any you could not read and why>
model:      <n> concepts added, <n> attaches, <n> no_concept, <n> types_no_concept
gaps:       <the translation gaps your lane added, one line each>
findings:   <n> mechanical, <n> design
```

Then one block per finding, exactly this shape:

```
FINDING:  <one line>
PATTERN:  alias-collision | translation-gap | no-home | duplicate | seam | boundary | dead-code
WHERE:    <file:line> and <file:line>
COST:     <what a reader must learn today to work here>
OPTION A: <keep X> - <what changes, what breaks, effort>
OPTION B: <keep Y> - <what changes, what breaks, effort>
ASK:      <the one question a human must answer>
```

Mark each finding `mechanical` or `design`. Mechanical means one obvious
right answer and no code change outside the concept; design means a human
must choose.

Do not propose a fix for a file outside your lane.

## Your files

- `crates/app-server/tests/auth_state.rs`
- `crates/app-server/tests/daemon.rs`
- `crates/app-server/tests/engine_stdio.rs`
- `crates/app-server/tests/machine_link_dispatch.rs`
- `crates/app-server/tests/machine_link_idle.rs`
- `crates/app-server/tests/machine_link_reconnect.rs`
- `crates/app-server/tests/mcp_skills.rs`
- `crates/app-server/tests/registry_client.rs`
- `crates/app-server/tests/ws_cloud.rs`
- `crates/codex-execpolicy/src/amend.rs`
- `crates/codex-execpolicy/src/decision.rs`
- `crates/codex-execpolicy/src/error.rs`
- `crates/codex-execpolicy/src/execpolicycheck.rs`
- `crates/codex-execpolicy/src/executable_name.rs`
- `crates/codex-execpolicy/src/lib.rs`
- `crates/codex-execpolicy/src/main.rs`
- `crates/codex-execpolicy/src/parser.rs`
- `crates/codex-execpolicy/src/policy.rs`
- `crates/codex-execpolicy/src/rule.rs`
- `crates/codex-execpolicy/src/sandbox_migration.rs`
- `crates/codex-execpolicy/src/sandbox_migration_tests.rs`
- `crates/codex-execpolicy/tests/basic.rs`
- `crates/codex-utils-absolute-path/src/absolutize.rs`
- `crates/codex-utils-absolute-path/src/lib.rs`
- `crates/guild-core/tests/tools.rs`
- `crates/protocol/build.rs`
