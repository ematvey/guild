# 004 Capabilities

Capabilities are what a Turn can use: the model behind each Step, the Tools it can call and the Skills it can load. The Org supplies all three. This document builds on [001 Domain model](001-domain.md) through [003 Execution](003-execution.md).

## Concepts

| Concept | Definition | Rules it keeps | Why it exists |
| --- | --- | --- | --- |
| Provider | One model vendor account: a protocol (`openai` or `anthropic`) and an encrypted key | Per Org. The key never leaves the server | The Org holds its own provider contracts |
| Model route | One model name mapped to a Provider, with prices, limits and an optional monthly quota | Unique per (Org, model). Disabled or keyless routes refuse calls. The model id is the wire identifier; the alias is only a display name | The Org decides which models exist and what they cost |
| Usage event | One model request's tokens and cost, attributed to Org, Member, Team and key | Written for every gateway call, including a stream aborted after its first frame | Spend is visible and enforceable |
| Tool | One capability the model can call | Is a built-in tool, an Integration tool, a Member's MCP tool or a Skill tool. Reaches a Turn only through the access rules of 002 | Everything an Agent does outside the model |
| Integration | A third-party service the Org connects, built in or served by MCP | Off until an admin enables it. Its secrets are encrypted and resolved at call time. Every Tool it declares has a class | Org data sources, under Org control |
| Trait | A capability Guild names and an Integration implements: `web_search`, `web_fetch` | The Tool name, description and schema are Guild's, whichever vendor serves it | Agents keep one tool name when the Org swaps vendors |
| Skill | A versioned instruction bundle in the Org registry: `SKILL.md` and its files | Published through one path. Each version is content-addressed by its sha256. A Member installs it, following the latest or a pinned version | Knowledge an Agent loads when it needs it, with provenance |
| Registry item | A catalog entry: a `skill`, an `mcp` server or an `integration` | Unique per (Org, kind, slug). Its review approves one version and hash, and any change returns it to draft | One reviewed catalog for everything installable |

## Models and the gateway

Every model call goes through the Org gateway. Agent Turns call it on a loopback provider, and outside callers use the same surfaces with an API key:

| Surface | Shape |
| --- | --- |
| `/openai/v1/chat/completions`, `/openai/v1/models` | OpenAI-shaped |
| `/anthropic/v1/messages` | Anthropic-shaped |

A call resolves its Model route and checks the route's quota, then streams from the Provider. A quota is a month-to-date spend in UTC; when it is reached, calls answer `quota_exceeded`. An unknown model answers 404, a disabled one `model_disabled`, and a keyless one `key_missing`.

An Agent has exactly one model. A new personal Agent takes the first enabled route. Every surface shows a route's alias, never the raw provider id.

## Tools

### The tools of a Turn

A Turn's tool set is assembled at admission, in this order:

1. **Base tools,** narrowed by the Agent's allowlist. Code mode is always kept.
2. **Integration tools,** narrowed by the allowlist. An Integration with no selected tool disappears.
3. **The Member's own MCP servers.**
4. **Workspace tools:** on a Machine-bound Thread, the `agent_*` tools, which sit outside the allowlist.
5. **Conversation tools,** narrowed by the allowlist.

File and shell tools are called directly. Integration and MCP tools are called through code mode: the model writes a short script that calls `tools.<name>`, and each nested call is gated on its own.

### The allowlist

An Agent's allowlist is `all` or `selected`. `all` means every built-in tool plus every Integration tool the Org enables, resolved at each Turn, so a new Integration reaches the Agent without an edit. A personal Agent starts with `all`.

| Group | Tools |
| --- | --- |
| Files and shell | `read`, `write`, `edit`, `list`, `bash` |
| Web | `web_search`; `web_fetch` arrives as an Integration's Trait tool |
| Skills | `read_skill`, `search_skills` |
| Conversations | `conversations_search`, `conversations_list`, `conversation_read` |
| Messaging | `send_message`, `send_file` |
| Routines | `schedule_reminder`, `list_routines`, `create_routine`, `update_routine`, `delete_routine` |
| Agent tree | `subagents` (one entry for spawn, send, read, list, cancel and close) |

The tree tools are one entry because an Agent that can spawn but not cancel or close leaves trees it cannot clean up.

### Integrations

An Integration is a plugin with a manifest: its fields, its Tools, its Traits and how it authenticates. A built-in Integration runs in the server. An MCP Integration comes from an approved registry item, and it runs only while that approval covers the item's latest version and hash.

Each Integration adds its Tools as `<slug>_<tool>`, plus a `list_tools` and `guide` pair. Curation and role policy decide which of its Tools a Member's Turn sees (see 002).

A Member can add their own MCP servers. Those servers are discovered at every Turn of that Member's Threads, and their headers are decrypted only at call time.

## Skills

### Publishing

A publish uploads a bundle, which is a `tar.gz` with a manifest. The publish path checks it for traversal and size, stores it under its sha256, and records the version with its `SKILL.md` text and file list. The HTTP route, the skills editor and the `push_skill` tool all publish through this one path.

A publish is refused when:

- the item is tombstoned;
- the item is maintainer-gated and the publisher is not its owner, a member of its owning team, or an admin;
- the version is older than the latest.

### Reading

An Agent reads a Skill with `read_skill`. The lookup goes in this order:

1. A `skills/<slug>` folder in the Thread's own files wins. It installs nothing and records no read.
2. Otherwise the Org's item, at the Member's pinned version or the latest. The first read installs it for the Member, unpinned.
3. The answer carries a provenance line: version, publisher, date, owner, fork origin and sha256.

Every read is recorded with Org, Member, Team and Thread. The prompt's Skills index lists the Member's installs with their pin, then the Org's other Skills marked as such.

### Machine sync

A Member's installs are also kept on each of their Machines, in `~/.agents/skills`. The server pushes the install list to online Machines when it changes. A Machine pulls the list when it connects.

The Machine converges its folder to the list: it verifies each bundle's sha256, extracts it with a provenance file, and removes folders that have a provenance file but are no longer listed. A folder without a provenance file is the Member's own and is never touched.

### Specialists

The specialist pack is a set of ordinary Org Agents: Source, Ops and Clients. Each has a fixed tool list and a playbook written into its `AGENTS.md`. Installing the pack is admin-only. It creates a missing file and never overwrites an existing one.

## Org prompts

An admin can replace two built-in prompts, each up to 10,000 characters; an empty value restores the default:

| Prompt | Used by |
| --- | --- |
| Assistant prompt | The Guild section of every Turn's system prompt |
| Auto-approval policy | The judge that decides Approvals (see 002) |

## Rejected

| Rejected | Reason |
| --- | --- |
| A model choice per Thread | The model belongs to the Agent (see 001) |
| Showing provider model ids | Members see the Org's aliases, and the id stays a wire identifier |
| Vendor tool names for search and fetch | Traits keep one name across vendors |
| An approval that survives a new version | A review covers one version and hash, so a change returns the item to draft |
| Removing unmanaged skill folders on a Machine | Only folders the sync wrote, marked by their provenance file, are its to remove |

## Open questions

- **Skill scope.** Installs and pins are per Member, so two Members using one shared Agent may get different Skills from it. The alternative is a per-Agent skill set (`selected` or `all`), like the tool allowlist.
- **Bundle trust.** Registry bundles are content-addressed but not signed. Only desktop releases are signed.
