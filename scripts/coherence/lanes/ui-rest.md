# Lane: ui-rest

## What you are doing

You are one of six read-only inspectors sweeping the Guild repo for
decoherence. The orchestrator has mapped 63 concepts and 124 files. Your lane
covers the 46 files below that nobody has read yet.

Area: the rest of the desktop client: the agents and skills surfaces, shared views, the lib helpers, the Tauri shell, and the build config.

## Hard rules

- **Read-only.** Do not edit, delete, move or format any source file. Do not
  run builds or tests that write. Do not touch git.
- Write only these two files:
  - `scripts/coherence/models/ui-rest.json` — your model fragment.
  - `scripts/coherence/lanes/ui-rest.report.md` — your findings.
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

Write `scripts/coherence/models/ui-rest.json` in the shape documented in
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

`scripts/coherence/lanes/ui-rest.report.md`:

```
lane:       ui-rest
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

- `apps/desktop/src-tauri/build.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src/components/context-ring.tsx`
- `apps/desktop/src/components/desktop-tooltip.tsx`
- `apps/desktop/src/components/hotkey-hint.tsx`
- `apps/desktop/src/components/user-badge.tsx`
- `apps/desktop/src/lib/api/workspaces.ts`
- `apps/desktop/src/lib/browser-send-store.ts`
- `apps/desktop/src/lib/format.ts`
- `apps/desktop/src/lib/oidc-login.ts`
- `apps/desktop/src/lib/outgoing-command.ts`
- `apps/desktop/src/lib/relative-time.ts`
- `apps/desktop/src/lib/skills.ts`
- `apps/desktop/src/lib/turn-context.ts`
- `apps/desktop/src/scroll-activity.ts`
- `apps/desktop/src/views/agents/ActivityPage.tsx`
- `apps/desktop/src/views/agents/AgentCreate.tsx`
- `apps/desktop/src/views/agents/AgentFiles.tsx`
- `apps/desktop/src/views/agents/AgentRoutines.tsx`
- `apps/desktop/src/views/agents/AgentThreadList.tsx`
- `apps/desktop/src/views/agents/AgentsDirectory.tsx`
- `apps/desktop/src/views/agents/AgentsPanel.tsx`
- `apps/desktop/src/views/agents/ChildThreadHeader.tsx`
- `apps/desktop/src/views/agents/JsonView.tsx`
- `apps/desktop/src/views/agents/MessagesView.tsx`
- `apps/desktop/src/views/agents/RunningSubagents.tsx`
- `apps/desktop/src/views/agents/activity-format.ts`
- `apps/desktop/src/views/agents/agent-model.tsx`
- `apps/desktop/src/views/agents/agent-ui.tsx`
- `apps/desktop/src/views/agents/subagent-blocks.tsx`
- `apps/desktop/src/views/device-setup.tsx`
- `apps/desktop/src/views/frame.tsx`
- `apps/desktop/src/views/js-highlight.tsx`
- `apps/desktop/src/views/markdown.tsx`
- `apps/desktop/src/views/onboarding.tsx`
- `apps/desktop/src/views/payload-pre.tsx`
- `apps/desktop/src/views/skills/ActivityFeed.tsx`
- `apps/desktop/src/views/skills/LocalSkills.tsx`
- `apps/desktop/src/views/skills/SkillEditor.tsx`
- `apps/desktop/src/views/skills/SkillsPanel.tsx`
- `apps/desktop/src/views/skills/skill-diff.ts`
- `apps/desktop/src/views/skills/skills-api.ts`
- `apps/desktop/src/views/worked-for-block.tsx`
- `apps/desktop/src/views/workspace-menu.tsx`
- `apps/desktop/vite.config.ts`
