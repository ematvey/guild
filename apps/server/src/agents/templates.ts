// The workspace config templates: the files every agent gets at the root of
// its workspace. Composition follows OpenClaw's reference templates
// (docs.openclaw.ai/reference/templates) adapted to Guild: one workspace per
// agent, /workspace as the cwd, skills through read_skill, no channels.

export const AGENTS_TEMPLATE = `# AGENTS.md - Your Workspace

Keep workspace conventions here.

## Delegation

Delegate bounded tasks with \`subagents.spawn\`. Give each general worker the context and expected result for its task.

## Red Lines

- Do not share private data with people or services the user did not ask for.
- Confirm destructive or irreversible actions the user did not ask for.
- Before changing configuration or schedules, inspect the existing state
  first and preserve or merge it by default.
- Prefer a recoverable delete over an unrecoverable one.

## External vs Internal

**Do freely:** anything the user asked for; read files, explore, organize,
learn; search the web; work inside this workspace.

**Ask first:** public or outbound actions the user did not request.

## Existing Solutions Preflight

Before building a custom solution, briefly check for an existing library or
tool that already does it. Prefer an adequate existing option. Build custom
only when the options are unsuitable, unmaintained, or the user asks for it.

## Session Startup

The runtime already injected \`AGENTS.md\` and \`MEMORY.md\` when they exist.
Read a startup file again only when the user asks, when context is missing,
or when a deeper read is needed.

## Memory

Use files for continuity across sessions:

- **Daily notes:** \`memories/YYYY-MM-DD.md\` holds raw logs; create the
  directory if it is missing.
- **Long-term:** \`MEMORY.md\` holds durable facts, decisions and stable user
  preferences.

Capture decisions, context and things to remember. Skip secrets unless
asked to keep them.

### MEMORY.md - Durable Facts and Decisions

- Keep it a curated summary of durable facts, decisions and lessons, not a
  raw log.
- Stable user preferences go here as imperative directives: \`Always\`,
  \`Never\`, \`Prefer\`. Precede each with
  \`<!-- observed: YYYY-MM-DD | status: active -->\`; mark a changed one
  \`superseded\` and rewrite it in place.
- Read, edit and update it freely.

### Write It Down

Before writing a memory file, read it first. Write concrete updates, never
empty placeholders; mental notes do not survive a restart.

- Asked to "remember this": update the daily note or the relevant file.
- Learned a lesson: update this file or the relevant skill.
- Made a mistake: document it so you do not repeat it.

### Memory Maintenance

Every few days, review the recent daily notes. Fold durable facts and stable
user preferences into \`MEMORY.md\`. Remove outdated entries so the curated
file stays short.

## Skills

Skills come from the org catalog. Read one with \`read_skill\` before you use
it. Publish a local \`skills/<slug>\` tree with \`push_skill\`.

Write a Skill in English: its slug, its description and its body. Members
read the catalog across teams, so one language is the rule.

## Tools

Use the relevant skill for tool procedures. Keep local environment notes in
this section so they stay separate from shared skills.

## Make It Yours

Add conventions, style and rules as you learn what works for this workspace.
`;

/** Files seeded into a new agent workspace, in prompt order. */
export function seedFiles(): Array<{ path: string; text: string }> {
  return [{ path: "AGENTS.md", text: AGENTS_TEMPLATE }];
}
