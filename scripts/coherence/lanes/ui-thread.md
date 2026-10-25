# Lane: ui-thread

## What you are doing

You are one of six read-only inspectors sweeping the Guild repo for
decoherence. The orchestrator has mapped 63 concepts and 124 files. Your lane
covers the 40 files below that nobody has read yet.

Area: the desktop chat surface: the thread view and its hooks, the sidebar panels, projects, and the settings sections.

## Hard rules

- **Read-only.** Do not edit, delete, move or format any source file. Do not
  run builds or tests that write. Do not touch git.
- Write only these two files:
  - `scripts/coherence/models/ui-thread.json` — your model fragment.
  - `scripts/coherence/lanes/ui-thread.report.md` — your findings.
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

Write `scripts/coherence/models/ui-thread.json` in the shape documented in
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

`scripts/coherence/lanes/ui-thread.report.md`:

```
lane:       ui-thread
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

- `apps/desktop/src/views/projects/CreateProjectDialog.tsx`
- `apps/desktop/src/views/projects/PathSpecifier.tsx`
- `apps/desktop/src/views/settings/components/empty-state.tsx`
- `apps/desktop/src/views/settings/components/fact-card.tsx`
- `apps/desktop/src/views/settings/components/field.tsx`
- `apps/desktop/src/views/settings/components/page-header.tsx`
- `apps/desktop/src/views/settings/resolve-project-dir.ts`
- `apps/desktop/src/views/settings/section-nav.ts`
- `apps/desktop/src/views/settings/sections/AboutSection.tsx`
- `apps/desktop/src/views/settings/sections/ApprovalsSection.tsx`
- `apps/desktop/src/views/settings/sections/AssistantSection.tsx`
- `apps/desktop/src/views/settings/sections/GatewaySection.tsx`
- `apps/desktop/src/views/settings/sections/MachineSection.tsx`
- `apps/desktop/src/views/settings/sections/McpSection.tsx`
- `apps/desktop/src/views/settings/sections/ModelsSection.tsx`
- `apps/desktop/src/views/settings/sections/RegistrySection.tsx`
- `apps/desktop/src/views/settings/sections/SsoSection.tsx`
- `apps/desktop/src/views/settings/sections/TeamsSection.tsx`
- `apps/desktop/src/views/settings/sections/UsageSection.tsx`
- `apps/desktop/src/views/settings/sections/UsersSection.tsx`
- `apps/desktop/src/views/settings/settings-sections.tsx`
- `apps/desktop/src/views/settings/use-cached-api.ts`
- `apps/desktop/src/views/sidebar-rail.tsx`
- `apps/desktop/src/views/sidebar/chats-panel.tsx`
- `apps/desktop/src/views/sidebar/chrome.tsx`
- `apps/desktop/src/views/sidebar/settings-panel.tsx`
- `apps/desktop/src/views/sidebar/work-panel.tsx`
- `apps/desktop/src/views/thread/Thread.tsx`
- `apps/desktop/src/views/thread/ThreadOverlays.tsx`
- `apps/desktop/src/views/thread/approval.ts`
- `apps/desktop/src/views/thread/attachments.tsx`
- `apps/desktop/src/views/thread/blocks.tsx`
- `apps/desktop/src/views/thread/hooks/use-chat-actions.ts`
- `apps/desktop/src/views/thread/hooks/use-outgoing.ts`
- `apps/desktop/src/views/thread/mentions.ts`
- `apps/desktop/src/views/thread/navigation.ts`
- `apps/desktop/src/views/thread/status.ts`
- `apps/desktop/src/views/thread/tool-blocks.tsx`
- `apps/desktop/src/views/thread/tool-text.ts`
- `apps/desktop/src/views/thread/use-visual-viewport-pin.ts`
