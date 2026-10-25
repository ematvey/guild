# Lane: srv-platform

## What you are doing

You are one of six read-only inspectors sweeping the Guild repo for
decoherence. The orchestrator has mapped 63 concepts and 124 files. Your lane
covers the 27 files below that nobody has read yet.

Area: the server's persistence and transport layer: every store class, the domain event helpers, and the HTTP route modules.

## Hard rules

- **Read-only.** Do not edit, delete, move or format any source file. Do not
  run builds or tests that write. Do not touch git.
- Write only these two files:
  - `scripts/coherence/models/srv-platform.json` — your model fragment.
  - `scripts/coherence/lanes/srv-platform.report.md` — your findings.
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

Write `scripts/coherence/models/srv-platform.json` in the shape documented in
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

`scripts/coherence/lanes/srv-platform.report.md`:

```
lane:       srv-platform
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

- `apps/server/src/platform/http/activity.ts`
- `apps/server/src/platform/http/admin.ts`
- `apps/server/src/platform/http/anthropic.ts`
- `apps/server/src/platform/http/llm.ts`
- `apps/server/src/platform/http/openai.ts`
- `apps/server/src/platform/http/register.ts`
- `apps/server/src/platform/http/thread-stream.ts`
- `apps/server/src/platform/integrations/connectors.ts`
- `apps/server/src/platform/integrations/execute.ts`
- `apps/server/src/platform/integrations/mcp.ts`
- `apps/server/src/platform/integrations/plugins.ts`
- `apps/server/src/platform/integrations/vendors/atlassian.ts`
- `apps/server/src/platform/integrations/vendors/firecrawl.ts`
- `apps/server/src/platform/integrations/vendors/github.ts`
- `apps/server/src/platform/integrations/vendors/gitlab.ts`
- `apps/server/src/platform/integrations/vendors/google-workspace.ts`
- `apps/server/src/platform/integrations/vendors/hubspot.ts`
- `apps/server/src/platform/integrations/vendors/langfuse.ts`
- `apps/server/src/platform/integrations/vendors/searxng.ts`
- `apps/server/src/platform/integrations/vendors/shared.ts`
- `apps/server/src/platform/integrations/vendors/slack.ts`
- `apps/server/src/platform/integrations/vendors/superproxy.ts`
- `apps/server/src/platform/provider/sse.ts`
- `apps/server/src/platform/provider/types.ts`
- `apps/server/src/platform/skillReads.ts`
- `apps/server/src/platform/store/org_kv.ts`
- `apps/server/src/platform/store/work.ts`
