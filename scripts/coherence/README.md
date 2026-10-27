# Coherence check

Decoherence is the accumulation of locally valid but incompatible designs.
It grows only when the system changes. A frozen system does not decay.

This directory holds two mechanisms.

**A floor.** Committed counters that may go down, never up. This stops the
cheap rot: more files, more lines, more shims, more copies.

**A model.** A committed map of the domain: one record per concept, its
canonical home, every place it appears, and how those places convert. This
targets the expensive problem: one word with two meanings, and one concept
kept in many places with no declared translation.

The model is the part that reads the code. The floor is the part that holds
the line.

## Commands

```bash
python3 scripts/coherence/check.py report   # counters, floor, seams, duplicates, model summary
python3 scripts/coherence/check.py check    # exit 1 on any failure (CI, pre-commit)
python3 scripts/coherence/check.py update   # rewrite floor.json from the current tree
python3 scripts/coherence/check.py seams    # every declared seam and its state
python3 scripts/coherence/check.py model    # model gaps, alias collisions, unmodeled types
python3 scripts/coherence/check.py coverage # files with no concept, per area
```

`check` is the gate. `update` is the only way to move the floor.

Scanned roots are `apps/`, `crates/` and `packages/`; scanned suffixes are
`.rs`, `.ts` and `.tsx`. `target/`,
`node_modules/` and `dist/` are skipped.

## Counters

| Counter | What it catches |
| --- | --- |
| `files` | The system getting bigger. |
| `loc` | The system getting longer. |
| `seams` | Declared places where two designs meet. |
| `shims` | Declarations that carry a second design: `Legacy*`, `Compat*`, `Shim*`, `Deprecated*`, `@deprecated`. |
| `duplicate_files` | Two files with identical content. One design kept in two places. |
| `translation_gaps` | Representations of a concept with no declared conversion. |
| `unmodeled_types` | Exported types under `model_roots` that no concept owns. |
| `unmapped_files` | Source files that no concept names and no `no_concept` entry excuses. |

`duplicate_files` counts the *extra* copies, not the groups.

`unmodeled_types` falls only when real types get a concept. It is the only
counter that measures how much of the domain is still unmapped.

`unmapped_files` is the reading backlog. It falls as concepts gain
representations. It is the honest number: the model is complete when this
reaches zero, and not before.

## The model

`models/*.json` hold the domain map, one fragment per area. The check merges
them and proves the result still matches the tree. It cannot prove the map is
complete.

Fragments exist so that several agents can extend the model in parallel
without fighting over one file. A conflict between two fragments is a real
finding, not a merge accident: the same concept or the same word appearing in
two areas.

```json
{
  "model_roots": ["crates/protocol/src"],
  "concepts": [
    {
      "id": "thread-event",
      "definition": "One row of a thread's append-only history log.",
      "canonical": "crates/protocol/src/api.rs",
      "types": ["ThreadEvent", "Block"],
      "aliases": ["thread_event"],
      "representations": [
        { "where": "crates/protocol/src/api.rs", "role": "wire" },
        { "where": "apps/server/src/platform/domain/thread-events.ts", "role": "db" },
        { "where": "apps/desktop/src/lib/thread-events.ts", "role": "ui" }
      ],
      "translations": [
        { "from": "db", "to": "wire", "at": "apps/server/src/platform/domain/thread-events.ts" }
      ]
    }
  ]
}
```

Two escape hatches keep the model honest without forcing a false split:

- `"shared_canonical": ["crates/protocol/src/api.rs"]` — a file that
  legitimately defines several wire concepts. A boundary mismatch, declared.
  Listing it is the finding, not the fix.
- `"types_no_concept": [{ "type": "CloudClient", "reason": "infrastructure" }]`
  — a type under a model root that carries no domain concept. Reasons come
  from the same fixed set as `no_concept`.

What the check enforces:

- every `canonical`, `representations[].where` and `attaches[].where` path
  exists
- no two concepts share a `canonical`, unless the file is in
  `shared_canonical`
- no two concepts share an `id` or an `alias`, compared case- and
  punctuation-blind
- every `translations[].from` and `.to` names a role the concept declares
- a concept with N roles and fewer than N-1 translations adds to
  `translation_gaps`
- every `no_concept` and `types_no_concept` reason is from the fixed set
- every `types_no_concept` name really is a type under a model root

What it cannot enforce: that a concept has all its representations listed.
That is why a human reads the model diff.

## Seams

A seam is a place where two designs meet: an adapter, a shim, a feature flag,
a fallback path, a `legacy` branch. Every seam must name an owner, a delete
date, and a reason. Write it next to the code:

```rust
// coherence:seam owner=@ematvey until=2026-12-31 reason="dual write during the migration"
```

```ts
// coherence:seam owner=@ematvey until=2026-12-31 reason="shipped clients still call the old route"
```

Three hard failures:

- **Missing field.** `owner`, `until`, and `reason` are all required.
- **Bad date.** The format is `YYYY-MM-DD`.
- **Expired.** The date is in the past.

To keep a seam past its date, move the date and write a new reason. A moved
date without a reason is not allowed.

The date is not a deadline for the work. It is the date the seam must be gone
or explicitly renewed. That difference is the whole point.

## When the check fails

| Failure | Answer |
| --- | --- |
| Floor raised | Remove something in the same change, or run `update` and commit the rise with a reason. |
| Seam expired | Delete the seam, or move the date and write a new reason. |
| Model path missing | Fix the model. The tree moved. |
| Alias collision | Two words for one thing, or one word for two things. A human decides which. |
| Same canonical twice | Two concepts share a home. Split the file, or declare it in `shared_canonical`. |
| Fragment does not parse | The JSON is broken. The message names the file. |

Do not raise the floor in a separate commit. The rise must be visible in the
change that caused it.

## Why these checks

They are not a model of design quality. They are a ratchet. A ratchet needs
three properties: cheap, stable, and hard to fake.

The counters have them. The model is harder to fake but not impossible: an
agent can delete a representation and make a gap disappear. The
`unmodeled_types` counter limits that. So does the model diff, which a human
reads.

Do not add a check that fires on ordinary work. A gate that cries wolf gets
switched off.

## Limits

- The check does not know which design is correct.
- The check cannot see intent, history, or why code exists.
- The check measures shape and vocabulary. It does not measure the time a
  reader needs to understand a module. That is the real cost, and it is not
  measured here.
- The check is a local rule for a global problem. It will not notice that the
  system has three competing paradigms and needs one to win.

## Agent skills

- `.agents/skills/decoherence-prevent/` — load before a change. Keeps the
  change inside one concept.
- `.agents/skills/decoherence-fix/` — load to clean up. Reads the code, builds
  the model, and finds the contradictions.

## Findings

`findings.md` is the running record: what was read, what the model now holds,
what was fixed, and what needs a human decision.
