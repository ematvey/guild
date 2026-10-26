---
name: decoherence-fix
description: Read the Guild code, build a domain model of it, and find real decoherence - one word with two meanings, one concept with many representations and no translation, a concept with no owner, or one design kept in two copies. Use when asked to clean up, deduplicate, consolidate, find legacy code, reduce complexity, or when scripts/coherence/check.py fails.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(git diff, git status, git log, python3 scripts/coherence/check.py *, grep, wc, find, ls)
---

# Fix Decoherence

Decoherence is not a file count. It is the presence of more than one valid
model of the same thing. A file count only shows the shadow of it.

So this skill does not start with grep. It starts with reading.

The work has two parts:

1. **Read the code and build a domain model.** Write it to
   `scripts/coherence/models/<area>.json`. This is the mental model, made durable.
2. **Compare the model against itself and against the tree.** The
   contradictions you find are the decoherence.

The model is the deliverable. The findings come from the model.

## Why the model must be a file

If you hold the model in your head, it dies when the session ends. The next
agent builds a different one. Then the agents are a new source of
decoherence, and the problem gets worse.

So the model is committed. Every agent reads the same one. The check proves
it still matches the tree. A human reviews the model diff, which is small and
readable, instead of reading every code change.

## Phase A - Read

Do not skip this phase. Do not start with grep.

```bash
cat AGENTS.md
cat PLAN.md docs/PRD.md docs/SRS.md
ls crates/ apps/ packages/
```

Then read the entry point of each area you care about:

```bash
ls crates/<name>/src apps/server/src apps/desktop/src
head -40 apps/server/src/<area>/*.ts
```

For each area, answer these questions:

1. What are the **nouns**? The things the system stores, moves, and reports on.
2. What are the **verbs**? The operations. Each verb belongs to one noun.
3. Where does each noun **live**? One file is the home.
4. Where else does it **appear**? Wire format, event format, database record,
   UI model, report payload.
5. How does it **convert** between those forms? A named function, or nothing.

Keep the answers short. One line per noun.

## Phase B - Write the model

Open `scripts/coherence/models/<area>.json` and add one record per concept.

```json
{
  "id": "patient",
  "definition": "One sentence. What the thing is, not what it does.",
  "canonical": "crates/protocol/src/api.rs",
  "types": ["ThreadEvent", "Block"],
  "aliases": ["thread_event"],
  "representations": [
    { "where": "crates/protocol/src/api.rs", "role": "wire" },
    { "where": "apps/server/src/platform/domain/thread-events.ts", "role": "db" },
    { "where": "apps/desktop/src/lib/thread-events.ts", "role": "ui" }
  ],
  "translations": [
    { "from": "db", "to": "wire", "at": "apps/server/src/platform/domain/thread-events.ts" },
    { "from": "wire", "to": "ui", "at": "apps/desktop/src/lib/thread-reducer.ts" }
  ]
}
```

Rules for the record:

- **`id`** is a noun, in lower case. `patient`, not `patientService`.
- **`definition`** is one sentence. If you need two, you have two concepts.
- **`canonical`** is the one file that defines it. If two files define it,
  that is a finding, not a choice.
- **`types`** are the Rust and TS types that carry this concept. Sub-types
  belong to the parent concept. `Block` is part of `ThreadEvent`.
- A file that legitimately defines several wire concepts goes in the
  fragment's `shared_canonical` list. A type under a model root that carries
  no concept goes in `types_no_concept` with a reason.
- **`aliases`** are other names for the same thing. These are the words that
  must not mean anything else.
- **`representations`** is every place the concept appears. Each one has a
  `role`: `domain`, `wire`, `event`, `db`, `ui`, `report`.
- **`translations`** is every declared way to convert between roles. If two
  roles exist and no function converts them, the gap is real.

Then check that the model is true:

```bash
python3 scripts/coherence/check.py check
python3 scripts/coherence/check.py model
```

The check fails when a path in the model does not exist. That means the model
is stale. Fix the model, not the check.

## Phase C - Find decoherence

The model now holds the findings. Look for these seven patterns.

| Pattern | What it means | How to see it |
| --- | --- | --- |
| **Alias collision** | One word, two meanings. Two teams will misread each other forever. | `check.py model` lists it. |
| **Translation gap** | A concept has N representations and fewer than N-1 conversions. The conversion happens somewhere, but nobody wrote it down. | `check.py model` prints the gap count. |
| **No canonical home** | A concept is defined in several places, or in none. Nobody owns it. | Concept has no `canonical`, or two have the same one. |
| **Duplicate copy** | One design kept in two files. They will drift. | `check.py report` lists duplicate groups. |
| **Unowned seam** | A patch that nobody will remove. | `check.py seams` shows expired or invalid markers. |
| **Unmodeled type** | The domain is bigger than the map. | `check.py model` lists the names. |
| **Boundary mismatch** | A module holds two concepts, or one concept spans three modules. | Read the model. Compare it with the directory tree. |

The last one needs your judgement. The other six are mechanical.

## Phase D - Act

Split every finding by one question: **does this need a design decision?**

| Finding | Class | Action |
| --- | --- | --- |
| Alias collision, and one name is clearly wrong | mechanical | Rename the alias. |
| Alias collision, both names are in use | **design** | Propose. |
| Translation gap with one obvious function | mechanical | Record the translation. |
| Translation gap with no function | **design** | Propose. The conversion is hiding somewhere. |
| Two files with identical content, one has no importers | mechanical | Delete the dead copy, fix imports. |
| Two files with identical content, both are imported | **design** | Propose one home (a `packages/` module or the nearest `lib/`). |
| Seam past its date, code unused | mechanical | Delete the seam and the code. |
| Seam past its date, code in use | **design** | Propose. Renew with a reason, or plan the removal. |
| Unmodeled type | mechanical | Add the concept, or record it as a sub-type. |
| Boundary mismatch | **design** | Propose. |

One finding per change. Never batch two.

After each change:

```bash
python3 scripts/coherence/check.py check
```

If a counter dropped, run `update` and commit `floor.json` in the same change.

### Tie-break rule

When two designs look equivalent, use this order:

1. The one with more callers wins.
2. The one inside the declared module wins.
3. The one that needs no new dependency wins.
4. If still equal, stop and ask.

## Phase E - Propose

For each design finding, write this block. Do not edit code.

```
FINDING:  <one line>
PATTERN:  alias-collision | translation-gap | no-home | duplicate | seam | boundary
WHERE:    <file:line> and <file:line>
COST:     <what a reader must learn today to work here>
OPTION A: <keep X> - <what changes, what breaks, effort>
OPTION B: <keep Y> - <what changes, what breaks, effort>
ASK:      <the one question a human must answer>
```

Three lines of trade-off are enough. Do not recommend unless asked.

## Report

```
read:       <areas and files read>
model:      <concepts added> added, <concepts changed> changed
findings:   <n> mechanical, <n> design
fixed:      <n>  (one line each)
floor:      files X->Y  loc X->Y  seams X->Y  shims X->Y  duplicates X->Y  gaps X->Y  unmodeled X->Y
proposed:   <n>  (blocks above)
verified:   check.py check | tests | build
```

## Limits

The check proves the model is **consistent**. It cannot prove the model is
**complete**. An agent can delete a representation and make a gap disappear.

Two defences:

- The `unmodeled_types` counter falls only when real types get a concept.
- A human reviews the model diff. That diff is the whole point. Keep it small.

Do not trust a clean check as proof that the domain is mapped. Trust the diff.
