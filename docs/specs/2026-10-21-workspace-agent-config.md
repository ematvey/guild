# Workspace agent config (OpenClaw-style)

Status: superseded (2026-10-24). The file set is now `AGENTS.md` and
`MEMORY.md`; the name and description live in the `agents` row. See the
2026-10-24 entry in `PLAN.md`.

## Problem

An agent's identity and instructions live in the `agents` table (`name`,
`instructions`) and are edited only through the agent settings form. The
agent cannot change them. The workspace, where the agent actually works,
holds memory but not configuration.

## Model

The workspace is the agent's home. A fixed set of root Markdown files is
read at the start of every thread and injected into the system prompt.
The agent edits them with its normal `write` / `edit` tools, so it can
change itself between turns.

Files, at the agent workspace root (`/workspace` in the sandbox):

| File | Purpose | Required |
| --- | --- | --- |
| `IDENTITY.md` | One line: name, vibe, emoji, avatar. Read into the UI. | yes |
| `SOUL.md` | Persona, tone, boundaries. | yes |
| `AGENTS.md` | Operating rules: red lines, memory policy, startup, tools. | yes |
| `USER.md` | User model as dated directives. | no |
| `MEMORY.md` | Curated long-term memory. | no |
| `BOOTSTRAP.md` | One-time first-run ritual; the agent deletes it. | no |
| `memories/` | Daily notes (`memories/YYYY-MM-DD.md`). | directory |

Composition follows OpenClaw: the templates and their sections come from
`docs.openclaw.ai/reference/templates/*`, adapted to Guild (one workspace
per agent, `/workspace` as cwd, skills through `read_skill`, no channels).

## Prompt assembly

`agentInstructions` becomes async and reads the files from
`<agentWorkspaceWriteRoot>/agents/<org>/<agent>` directly — no sandbox
round trip. Order, stable first for provider prefix caching:

1. runtime block (identity line, workspace path, sharing note, "do not
   mention internals")
2. `IDENTITY.md`, `SOUL.md`, `AGENTS.md`
3. `USER.md`, `MEMORY.md`
4. `BOOTSTRAP.md` (only while it exists)
5. a short "your files" note: the files are yours, edit them, changes apply
   on the next turn

Caps: 8 KiB per file, 24 KiB total. A truncated file gets a marker that
says to read the file for the rest. A missing required file gets one
`(missing: NAME)` marker line; a missing optional file is skipped.

## Identity in the UI

`IDENTITY.md` is one line of `Label: value` pairs separated by `|`:

```
- Name: Scout | Vibe: direct and calm | Emoji: 🧭 | Avatar: avatars/avatar.png
```

Parsed values ride the agent payload as `identity` (`name`, `vibe`,
`emoji`, `avatar`). Unfilled placeholder text in parentheses is ignored.
`name` in the `agents` row stays the directory/list name; the identity
line is what the agent calls itself.

## Seeding

Every new agent — personal or created — is seeded from the templates when
its workspace directory is first created. Existing files are never
overwritten. `memories/` is created empty.

`agents.instructions` becomes a mirror of `AGENTS.md`: a create with
instructions writes them into the file, a `PATCH` with instructions
rewrites the file, and a read returns the file's text. The column stays
for compatibility with the directory list.

## Migration

Existing agents get the templates on their next turn or on the re-init
run. Seeding on a turn creates only missing files and never overwrites a
file the agent has edited. `scripts/agents-reinit.ts --org <orgId>` is the
deliberate reset: it deletes each agent's `AGENTS.md` and seeds it fresh
from the template, leaving every other file alone.
