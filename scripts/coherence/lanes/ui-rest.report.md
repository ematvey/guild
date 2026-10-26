lane:       ui-rest
read:       46 files, all read in full (none skipped)
model:      2 concepts added, 30 attaches, 17 no_concept, 0 types_no_concept
gaps:       none added (workspace-session: wire→ui declared; project-instructions: one role)
findings:   5 mechanical, 8 design

FINDING:  "initials" has three rules and no single home
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/skills/SkillDetail.tsx:235 (avatarChip: first two chars, uppercased) and apps/desktop/src/views/skills/SkillsPanel.tsx:97 (ownerInitials: same body, second copy) and apps/desktop/src/views/agents/agent-ui.tsx:83 (initials: first letter of the first two words)
COST:     a reader learns three chip rules and must guess which one a surface uses; user-badge.tsx:28 holds a fourth inline copy.
OPTION A: keep avatarChip - move it to a shared module, delete ownerInitials and the user-badge inline, rename agent-ui.initials to nameInitials and declare the difference. Small effort, no behaviour change.
OPTION B: keep three rules - list each one in the model and name the surface that owns it. No code change, the ambiguity stays.
ASK:      is an avatar chip the first two characters of a label, or the first letters of two words?

FINDING:  "N things" pluralization is written in five places
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/agents/activity-format.ts:27 (count) and apps/desktop/src/views/agents/AgentsDirectory.tsx:202, apps/desktop/src/views/skills/SkillsPanel.tsx:76, apps/desktop/src/views/skills/SkillsPanel.tsx:503, apps/desktop/src/views/agents/AgentPage.tsx:246
COST:     AgentPage.tsx:246 prints "1 tools"; the other four each re-derive the singular rule; count() serves only the activity tables.
OPTION A: keep count() - import it in the five places and delete the inline templates. Mechanical, no API change.
OPTION B: keep inline text - the singular rule stays per file and will drift again.
ASK:      should one helper own every "N things" label in the client?

FINDING:  relative time has a past rule and a second, separate future rule
PATTERN:  duplicate
WHERE:    apps/desktop/src/lib/relative-time.ts:3 (relativeTime, clamps future stamps to "just now") and apps/desktop/src/views/agents/AgentRoutines.tsx:78 (nextRunLabel, formats future stamps)
COST:     the same stamp renders two ways depending on direction, and the future rule lives in a view file, not the time module.
OPTION A: keep lib/relative-time.ts - add the future branch there and let AgentRoutines import it. Mechanical, one exported name changes.
OPTION B: keep nextRunLabel - declare both in the model and accept that a view owns a time format.
ASK:      does one module own every relative time label?

FINDING:  "session" means a chat, a login, and the engine token
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/agents/ActivityPage.tsx:646 ("A session is one chat") and apps/desktop/src/views/agents/ActivityPage.tsx:749 (onOpenChat(sessionId)) and apps/server/src/platform/store/identity.ts (server-core:session) and crates/app-server/src/session_store.rs (engine:session)
COST:     a reader meets "session" in three layers. The activity route /sessions/<id> carries a chat id, so a chat has two addresses.
OPTION A: keep "session" for login only - rename the activity surface to chats, route /chats/<id>, drop SessionRow. Breaks deep links, medium effort.
OPTION B: keep the activity "session" - rename the login concepts instead (login-session). Touches server, engine and desktop. Large effort.
ASK:      which of the three keeps the word "session"?

FINDING:  "workspace" means a signed-in server and an agent's folder
PATTERN:  alias-collision
WHERE:    apps/desktop/src/lib/api/workspaces.ts:11 (WorkspaceRow: one signed-in server) and crates/guild-core/src/tools/workspace.rs (engine:workspace: the root folder) and apps/desktop/src/views/agents/AgentPage.tsx:649 (Section "Workspace": the agent's file area)
COST:     the switcher, the engine allowlist and the agent file browser all say "workspace" and mean three different things. The model now needs "workspace-session" to keep them apart.
OPTION A: keep workspace = folder - rename the switcher rows to servers (ServerRow, server list, /api servers). Client-only rename, medium effort.
OPTION B: keep the switcher word - rename the engine folder concept (workdir is already an alias). Touches engine and server.
ASK:      is a signed-in server a workspace?

FINDING:  one /runs/<id> route takes a run id and a trace id
PATTERN:  seam
WHERE:    apps/desktop/src/views/agents/AgentRoutines.tsx:419 (run.id into runId) and apps/desktop/src/views/agents/ActivityPage.tsx:478 (row.trace_id into runId) and apps/desktop/src/views/agents/agents-api.ts:735,766 (TraceRow.trace_id and SpanRow.run_id)
COST:     a run row and a trace row are two records in two stores; the route cannot say which one it holds, so a reader must learn both id spaces to open one page.
OPTION A: keep run.id as the route key - make the trace list resolve the run id and show trace-only turns by trace id under a separate route. Medium effort.
OPTION B: keep trace_id - drop the run route and read everything from the trace store. Loses run rows that have no trace.
ASK:      which id owns /runs/<id>?

FINDING:  "call" is an LLM span, "span" is every span
PATTERN:  boundary
WHERE:    apps/desktop/src/views/agents/ActivityPage.tsx:204 (Calls tab asks for type: "llm") and apps/desktop/src/views/agents/agents-api.ts:769 (span_type is llm | tool | run) and apps/desktop/src/views/agents/ActivityPage.tsx:557 ("Calls are recorded on every gateway model request and approval judge verdict")
COST:     the summary counts calls and tool_calls as separate totals, while the wire type calls a tool row a span. A reader must learn that a call is not a span and a tool call is not a call.
OPTION A: keep "call" = LLM request - say so in the tab and keep tool spans out of it. No code change beyond labels.
OPTION B: keep the tab as a span list - rename it Spans, add a type filter. Medium effort.
ASK:      is a tool call a call in this surface?

FINDING:  two rules build a turn's instruction documents
PATTERN:  duplicate
WHERE:    apps/desktop/src/lib/turn-context.ts:45 (32 KiB, AGENTS.override.md beats AGENTS.md, one file per directory from the git root down) and apps/server/src/agents/workspace-config.ts:10-12 (8 KiB per file, 24 KiB total, AGENTS.md and MEMORY.md only)
COST:     the same turn can receive two instruction sets with two budgets and two file sets. A reader cannot tell which text the model actually saw.
OPTION A: keep the client chain - the server reads the same chain from the bound project folder. One rule, server work.
OPTION B: keep the server files - delete the client chain and let the server send the instructions. Breaks the desktop-only project path.
ASK:      which budget and which file set is the contract for a turn's instructions?

FINDING:  two HTTP clients for the same skills endpoints
PATTERN:  duplicate
WHERE:    apps/desktop/src/lib/api/skills.ts:10-41 (orgSkillsApi: silent null on any failure) and apps/desktop/src/views/skills/skills-api.ts:105-160 (own authHeaders, null on !ok)
COST:     GET /api/v1/skills/installs and GET /api/v1/skills/:slug/source are implemented twice, with two error contracts. A change to either endpoint must be made in two files.
OPTION A: keep skills-api.ts - make lib/api/skills.ts call it for installs and source. Small effort, one error contract.
OPTION B: keep lib/api/skills.ts for the turn path - then declare the split in the model and stop adding endpoints to both.
ASK:      does the turn assembly share the skills panel's HTTP client?

FINDING:  ChatMessage names two different shapes
PATTERN:  alias-collision
WHERE:    apps/desktop/src/views/agents/MessagesView.tsx:10 (tool_calls[].function.name / .arguments, content can be parts) and apps/desktop/src/lib/api/chats.ts:69 (tool_calls[].name / .arguments, content is a string)
COST:     two exported interfaces share one name, and neither matches protocol Message. A reader who learns one breaks on the other.
OPTION A: keep protocol Message - map both readers into it. Medium effort, one wire shape.
OPTION B: keep both - rename the payload reader to PayloadMessage and declare it as a separate view model.
ASK:      which ChatMessage shape is the wire contract?

FINDING:  the agent export and the delete dialog are written twice in one file
PATTERN:  duplicate
WHERE:    apps/desktop/src/views/agents/AgentPage.tsx:375 and apps/desktop/src/views/agents/AgentPage.tsx:703 (identical download body) and apps/desktop/src/views/agents/AgentPage.tsx:427 and apps/desktop/src/views/agents/AgentPage.tsx:1024 (identical delete dialog)
COST:     a change to the export name or the delete warning must be made twice in the same file.
OPTION A: keep one AgentActions block - AgentSettings renders the same menu and dialog. Mechanical, small effort.
OPTION B: keep both - they will drift on the next copy change.
ASK:      does the settings tab need its own delete dialog?

FINDING:  the agents surface has two URL models
PATTERN:  boundary
WHERE:    apps/desktop/src/views/agents/ActivityPage.tsx:98-131 (readListState / writeListState / pushState, query-only) and apps/desktop/src/views/agents/agents-route.ts:59,99 (parseAgentsRoute / agentsRoutePath)
COST:     tab, period, status, trigger, query, caller and model live outside AgentsRoute. Back and forward are handled twice, and a route change cannot carry an activity filter.
OPTION A: keep agents-route.ts - move the activity query into AgentsRoute and delete the local reader/writer. Medium effort, one route model.
OPTION B: keep the local writer - declare it in the model and accept that the surface has two navigation owners.
ASK:      does the activity filter belong in the agents route?

FINDING:  a skill version is a string with two shapes and three helpers
PATTERN:  translation-gap
WHERE:    apps/desktop/src/views/skills/skills-api.ts:32 (displayVersion: strips a leading "v", then adds "v") and apps/desktop/src/views/skills/SkillsPanel.tsx:130 (versionRank: /^v(\d+)$/) and apps/desktop/src/views/device-setup.tsx:30 (compareVersions: splits on ".")
COST:     the server computes "v1" while a user publishes "0.1.0". No conversion is declared, so each helper guesses. versionRank returns 0 for every semver string.
OPTION A: keep one stored shape - store bare numbers or bare semver, format once at the edge. Migration of stored versions, medium effort.
OPTION B: keep both shapes - declare a version concept with one parser and one formatter and route all three helpers through it.
ASK:      is a skill version a counter or a semver string?

notes:
- The floor is stale for the whole sweep, not for this lane: loc 122389 -> 122428 (+39) and unmapped_files 215 -> 0. The orchestrator runs `update` once at the end.
- The checker does not catch a concept id declared twice with different canonicals. `session`, `approval`, `skill`, `agent`, `machine`, `project`, `chat` and `thread-event` each appear in two or three fragments, and `check.py model` stays silent because it only compares alias keys. That is a hole in the gate, not a lane finding.
- `subagent` has no concept in any fragment. The tree builder is apps/desktop/src/views/agents/RunningSubagents.tsx:23 and the wire node is ChatSubagentNode in apps/desktop/src/lib/api/chats.ts:59. I attached the views to `agent-thread` rather than invent a concept whose canonical file belongs to another lane.
