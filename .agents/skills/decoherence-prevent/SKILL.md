---
name: decoherence-prevent
description: Prevent decoherence while changing code in the Guild repo. Use before and during any task that adds files, types, modules, abstractions, adapters, feature flags, fallback paths, or a second way to do something that already exists. Loads the committed domain model, keeps the change inside one declared box, and stops before a new box is created.
allowed-tools: Read, Grep, Glob, Edit, Bash(git diff, git status, git log, python3 scripts/coherence/check.py *)
---

# Prevent Decoherence

Decoherence is the accumulation of locally valid but incompatible designs.
It grows only when the system changes. So the control is on the change.

The method is one rule:

> The agent may fill a declared box. The agent may not make a new box.

A box is a **concept** in `scripts/coherence/models/<area>.json`. It is not a folder.

## When to load this skill

Load it before the first edit in any task that:

- adds a new file, package, module, or directory
- adds a type, interface, or base class
- adds an adapter, shim, compatibility branch, or fallback path
- adds a feature flag
- adds a dependency
- adds a second way to do something the repo already does
- changes a boundary between components

Do not load it for a change that only edits the body of one function.

## Step 1 - Name the concept

Read the model. Find the concept that your change belongs to.

```bash
python3 scripts/coherence/check.py model
```

Then read the record:

```bash
grep -n -A20 '"id": "<concept>"' scripts/coherence/models/<area>.json
```

Answer three questions in writing:

1. Which concept does this change belong to?
2. Which file is the canonical home?
3. Does the change need a new concept, a new type, or a new dependency?

If question 3 answers yes, **stop**. State what you need and why. Wait for a
human decision. A new concept is a design decision. It is not a coding step.

If no concept matches, the domain model is incomplete. That is a finding, not
a licence. Report it and ask.

## Step 2 - Read the floor

```bash
python3 scripts/coherence/check.py report
```

Record the counters. You will compare them at the end.

## Step 3 - Use the canonical home

Edit the canonical file, or a file in the same module. Do not create a second
home for a concept that already has one.

Before you write a new helper, client, parser, or type:

```bash
grep -rn "<capability>" crates/ apps/ packages/ \
  --include=*.rs --include=*.ts --include=*.tsx \
  --exclude-dir=node_modules --exclude-dir=target \
  --exclude-dir=dist --exclude-dir=build \
  --exclude-dir=bindings
```

Search for the capability, not the name. Search for the URL host, not for
`httpClient`. Search for the date format string, not for `formatDate`.

If one implementation exists, use it. If two exist, do not add a third.
Report the two and ask which one wins.

## Step 4 - Keep the model true

If your change adds a representation of a concept, add it to the model in the
same change:

```json
{ "where": "apps/client-core/src/entities/patient/model.ts", "role": "ui" }
```

If two roles now exist, declare how they convert:

```json
{ "from": "wire", "to": "ui", "at": "apps/client-core/src/entities/patient/lib/mapPatient.ts" }
```

An undeclared conversion is the cost this tool exists to count. Do not hide it.

If your change adds a word that already means something else, stop. That is an
alias collision. Two meanings for one word is the most expensive decoherence
there is.

## Step 5 - Mark every seam

If the change needs a seam, mark it in the same change.

```rust
// coherence:seam owner=@handle until=2026-12-31 reason="why this exists"
```

```ts
// coherence:seam owner=@handle until=2026-12-31 reason="why this exists"
```

All three fields are required. The date is the delete date, not a deadline.

If you cannot name an owner, the seam is not ready. Ask.

## Step 6 - Pay for what you add

If a counter rises, remove something in the same change. Good candidates:

- a seam whose date passed
- a `Legacy*` or `Compat*` declaration with no caller
- a branch behind a flag that is always on
- a duplicate file from `check.py report`
- a concept record for a type that no longer exists

If nothing can be removed, say so and show the rise. Do not hide it.

## Step 7 - Run the check

```bash
python3 scripts/coherence/check.py check
```

Exit 0 means the change is inside the floor and the model still matches the
tree. Exit 1 means a seam expired, a counter rose, or the model went stale.

Fix the model first. A stale model is a worse problem than a raised counter.

## Step 8 - Report

```
concept:    <id from the model>
home:       <canonical file>
new box:    no | yes - <what and why>
model:      <records added or changed>
counters:   files X->Y  loc X->Y  seams X->Y  shims X->Y  duplicates X->Y  gaps X->Y  unmodeled X->Y
seams:      <file:line owner until>
deletions:  <what was removed, or "none - rise accepted">
```

## Hard rules

- Never add a second HTTP client, date library, logger, config loader, error
  type, or async style. Use the existing one, or ask.
- In the desktop client the token and the server URL have one home:
  `apps/desktop/src/lib/session.ts`. Import them; never read the raw
  `localStorage` keys.
- Never add a compatibility branch without a marker and a delete date.
- Never create a new top-level module, package, or concept without approval.
- Never copy a file. Import it, or move it to one shared home.
- Never give a new thing a name that already means something else.
- Never leave a conversion between two representations undeclared.
- Never raise the floor in a separate commit. The rise must be visible in the
  change that caused it.
- Never "clean up" code outside the declared concept. That opens a second seam.

## What this skill cannot do

It cannot decide which design is correct. It cannot see intent or history.
It cannot enforce itself. It shapes behaviour. The check enforces.

When two designs both have callers, stop. Write the trade-off in three lines.
Ask. Do not pick one.
