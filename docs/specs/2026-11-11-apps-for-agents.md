# Apps for Agents

Status: implemented (0.6.93). Builds on [2026-11-09-apps](2026-11-09-apps.md) and the
rules in [004 Capabilities](../domain/004-capabilities.md) ("Apps").

## Problem

An App is a lasting page over live Integration data. Agents can create one
(`publish_app`) and nothing else. Three gaps:

1. **No discovery.** The tool list holds `publish_app` alone. Nothing tells
   an Agent which Apps exist, so it guesses. In one live thread it guessed
   that the App "gearbox" was a GitLab project or a Confluence page, and
   spent calls looking there.
2. **No read.** An Agent cannot read an App's manifest or its page, so it
   cannot fix or extend an App it did not write.
3. **No edit beyond its own, no use.** `publish_app` takes `app_id` only for
   an App the thread's member owns. The store already admits any App the
   member may edit. And an Agent cannot call an App's data functions, so
   the data an App holds is invisible to it.

## Decisions

1. **Apps are a capability with four verbs.** Discover (`list_apps`), read
   (`read_app`), edit (`publish_app`, `set_app_access`), use (`call_app`).
   The same access list that decides who opens an App decides who reads,
   edits and calls it: `read` for the first three, `edit` for the fourth.
2. **An Apps index rides the system prompt.** One line per App the member
   sees: name, id, version, `can_edit`, and the function names. The Skills
   index is the model. Discovery then costs no tool call, and the guessing
   in the problem above cannot repeat.
3. **`read_app` writes the page into the workspace, not into the
   context.** It returns the manifest always, and with `page: true` (the
   default) it writes the HTML to `apps/<app_id>/index.html` and returns
   the path. The Agent edits the file and publishes it back.
4. **An edit is a publish.** `publish_app` takes the `app_id` of any App
   the member may edit. The publish-time reach check, the version bump and
   the "new version asks again" grant rule do not change.
5. **The access list is its own tool.** `set_app_access` replaces the
   list of one App. The owner, an admin, or an `edit` entry may call it.
   It does not bump the version: access is not page code.
6. **`call_app` runs one function as the member.** It goes through
   `memberTool` + `runMemberTool` with `via: "app"`, the App and the
   function, like the page's call route. A `read`-class function runs at
   once. A `write`/`admin`-class or `always_ask` function needs the
   member's yes: the approval gate asks with its standard card, and the
   call runs only after the yes. The gate classifies the call from its
   `app_id` and `function` arguments.
7. **One Apps namespace in code mode.** `list_apps`, `read_app`,
   `call_app`, `set_app_access` join `publish_app` under `apps`, so a
   script finds them together.

## Surfaces

| Tool | Parameters | Returns |
| --- | --- | --- |
| `list_apps` | `query?` | The Apps the member sees: id, name, description, owner, version, visibility, `can_edit`, functions |
| `read_app` | `app_id`, `page?` (default true) | The manifest with its access entries and functions; the page path, size and sha256 |
| `publish_app` | as today; `app_id` now admits any App the member may edit | as today |
| `set_app_access` | `app_id`, `entries[]` (`subject_kind`, `subject_id`, `level`) | the stored entries |
| `call_app` | `app_id`, `function`, `params?` | the tool result (`{data, text, meta}`) |

Prompt: an `<apps>` section after the Skills index, one line per App, capped
and ordered by the App list.

## Rules kept

- A publish checks every data function against the member's reach, as today.
- A call acts for the viewer: their Integration ceilings, the Org's
  curation, and the `integration.tool_called` event.
- The per-member, per-App budget of 120 calls a minute covers agent calls
  too, so a script loop cannot outrun the page.
- The 4 MiB result cap applies; an Agent result also passes through the
  tool's own output limit, which spills to an artifact.
- A call whose function is unavailable to the member is a tool error with
  the reason, not a thrown 403.

## Out of scope

- `delete_app`: deletion stays the owner's UI action.
- Per-App state and `guild.ask`.
- Rendering an App inside a thread.

## Files to touch

- `apps/server/src/agents/app-tools.ts` (new): `list_apps`, `read_app`,
  `call_app`, `set_app_access`.
- `apps/server/src/agents/publish-app.ts`: admit `app_id` for a `can_edit`
  App; share the reach check.
- `apps/server/src/agents/types.ts`: the four names in `AgentToolName` and
  `ALL_AGENT_TOOLS`.
- `apps/server/src/agents/tools.ts`: wire the context.
- `apps/server/src/harness/turn-tools.ts`: pass the App store, the member
  and the workspace root.
- `apps/server/src/harness/instructions.ts`: the `<apps>` index section.
- `apps/server/src/harness/codemode-namespaces.ts`: the `apps` group.
- `apps/server/src/harness/approvals.ts` + the App gate: the write-class
  ask for `call_app`.
- `apps/server/src/platform/http/agents.ts`: the tool catalog rows.
- `docs/domain/004-capabilities.md`: the Apps section and the group table.
- `PLAN.md`: the entry.
