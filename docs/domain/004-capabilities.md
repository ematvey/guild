# 004 Capabilities

Capabilities are what a Turn can use: the model behind each Step, the Tools it can call, the Skills it can load, the Generated UI it can write and the Apps it can publish. The Org supplies all of them. This document builds on [001 Domain model](001-domain.md) through [003 Execution](003-execution.md).

## Concepts

| Concept | Definition | Rules it keeps | Why it exists |
| --- | --- | --- | --- |
| Provider | One model vendor account: a protocol (`openai` or `anthropic`) and an encrypted key | Per Org. The key never leaves the server | The Org holds its own provider contracts |
| Model route | One model name mapped to a Provider, with prices, limits and an optional monthly quota | Unique per (Org, model). Disabled or keyless routes refuse calls. The model id is the wire identifier; the alias is only a display name | The Org decides which models exist and what they cost |
| Usage event | One model request's tokens and cost, attributed to Org, Member, Team and key | Written for every gateway call, including a stream aborted after its first frame | Spend is visible and enforceable |
| Tool | One capability the model can call | Is a built-in tool, an Integration tool, a Member's MCP tool or a Skill tool. Reaches a Turn only through the access rules of 002 | Everything an Agent does outside the model |
| Integration | A third-party service the Org connects: built in, an installed Plugin, or served by MCP | Off until an admin enables it. Has an audience that decides who may add it to an Agent (see 002). Its secrets are encrypted and resolved at call time. Every Tool it declares has a class | Org data sources, under Org control |
| Trait | A capability Guild names and an Integration implements: `web_search`, `web_fetch` | The provider prefixes the callable Tool name. Guild supplies the description and schema | Agents keep the same allowlist entry when the Org swaps vendors |
| Skill | A versioned instruction bundle in the Org registry: `SKILL.md` and its files | Published through one path. Each version is content-addressed by its sha256. A Member installs it, following the latest or a pinned version | Knowledge an Agent loads when it needs it, with provenance |
| Generated UI | Interactive components an Agent writes into a reply: an `openui` fenced block holding an OpenUI Lang program over Guild's component library | Per Agent, on by default. Takes one answer: the first user message after it settles its controls. Only the library's components render; a block runs no Tool and no HTML. A click leaves the block only as the Member's next message in the Thread or a web link opened outside the app. Spawned Threads never get it | Answers that need structure, numbers or input read as UI, not prose |
| App | An HTML page an Agent publishes, with named data functions, that a Member opens from the Apps page | Owned by the Member the publishing Thread acts for. Who may open and edit it is its Access list (see 002): everyone in the Org, Teams, or named Members. Each publish is a new version and the newest runs. The page has no network: it reads Integrations only through its data functions, and every call acts for the viewer. An Agent discovers the Apps its Member can open, reads one with its page, publishes a version of any App that Member may edit, changes that App's list, and calls its functions for that Member | Live views of Org data (dashboards, trackers) that outlast the Thread that made them |
| Data function | One named call an App's page may make: one Integration tool, fixed arguments, and typed, bounded parameters the page fills in | Declared at publish and checked against the publisher's reach. Runs with the viewer's own reach, the Org's curation and the audit of a script call. A `write`/`admin`-class or `always_ask` tool asks the viewer before a call, unless they granted that function of that App version | The page never chooses a tool or the shape of its arguments, so the manifest says everything an App can do |
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
2. **Integration tools:** the Integrations in the Agent's Integration list, each narrowed to the classes within its entry's ceiling. Trait tools follow the allowlist instead. An Integration with no offered tool disappears.
3. **The Member's own MCP servers.**
4. **Conversation tools,** narrowed by the allowlist.

File and shell tools are called directly. Integration and MCP tools are called through code mode: the model writes a short script that calls `tools.<name>`, and each nested call is gated on its own.

Before a code-mode script executes, its static check refuses straight-line loops of independent Integration reads and batches of four consecutive independent reads, with a correction asking for `Promise.all`. Read effects come from the admitted Integration declarations; known HubSpot GET and CRM search requests also qualify. Pagination, ordered writes and uncertain dependencies remain sequential. A post-execution timing hint covers serial batches the static check cannot establish.

Each conversation has at most eight tool operations in flight. Installed tool implementations and the approval classifier's Integration discovery share this limit, including dynamically installed tools. A queued operation cancelled before execution is removed; authorization is checked when its classification runs. The timing hint is conditional because combined durations do not establish whether calls overlapped, and its batching advice preserves dependencies on both results and side effects.

Integration calls compare their approval classification with fresh policy when execution begins. A stricter policy ends the call with a retry instruction so it can pass the approval gate again; it never opens an interactive approval while holding an execution slot. The static check declines scripts with shadowed capabilities, duplicate function declarations or unknown object mutations, and excludes file-producing reads from batching advice.

Code mode lists the tools a script can call grouped into namespaces: groups of Guild's own tools, one per Integration (named by its slug), and one per MCP server. A namespace only groups tools for discovery; a script still calls each tool as `tools.<name>`.

### The allowlist

An Agent's allowlist is `all` or `selected`. `all` means every built-in tool and Trait tool, resolved at each Turn, so a tool added in a later release reaches the Agent without an edit. It also covers Integrations, through a derived Integration list that follows the Integrations' audiences: an Integration an admin enables or opens up reaches every `all` Agent whose users it covers (see 002). A `selected` Agent's Integrations are an explicit list. A personal Agent starts with `all`.

| Group | Tools |
| --- | --- |
| Files and shell | `read`, `write`, `edit`, `list`, `bash` |
| Web | The `web_search` and `web_fetch` Trait IDs grant access to the selected providers’ tools |
| Skills | `read_skill`, `search_skills` |
| Conversations | `conversations_search`, `conversations_list`, `conversation_read` |
| Messaging | `send_message`, `send_file` |
| Apps | `list_apps`, `read_app`, `publish_app`, `set_app_access`, `call_app` |
| Routines | `schedule_reminder`, `list_routines`, `create_routine`, `update_routine`, `delete_routine` |
| Agent tree | `subagents` (one entry for spawn, send, read, list, cancel and close) |
| Org (admin only) | `guild_overview`, `guild_members`, `guild_usage`, `guild_threads`, `guild_thread_read`, `guild_agents` |

The tree tools are one entry because an Agent that can spawn but not cancel or close leaves trees it cannot clean up.

The org tools are the admin's read of the whole Org: member counts and teams, the usage events, every member's Thread and its transcript, and every Agent. They reach a Turn only when the Agent is its owner's personal Agent and the owner is an admin; every other Agent's Turn has none of them. They read the same stores the admin's HTTP surfaces read, so a Member's Thread that the sidebar list never shows an admin is still listed and readable there. They are script-callable only, under the `guild` namespace of code mode.

### Integrations

An Integration is a plugin with a manifest: its fields, its Tools, its Traits and how it authenticates. It comes in three kinds:

| Kind | Where it comes from | How it runs |
| --- | --- | --- |
| Built-in | A plugin folder compiled into the server: code, or an MCP plugin wrapping a remote MCP server | A code built-in runs in the server process, and a Tool's class is its code declaration unless an admin curates one. An MCP built-in serves its manifest as an approved MCP item would, with no publishing, and runs as the MCP kind below |
| Plugin | An approved registry item whose bundle carries a `plugin.js` (`runtime: "code"`), built against `@guild/integration-sdk`. It may not reuse a built-in slug | In a worker thread of the server, loaded from the approved bundle bytes (checked against the approved hash). A Tool's class is its code declaration unless an admin curates one |
| MCP | A built-in catalog manifest or an approved registry item naming a remote MCP server. An admin connects one from the Integrations page, which publishes and approves the item in the same step, or installs an MCP plugin bundle (`mcpIntegration` packed with no code) from a catalog, a file or a URL | On the remote server. A registry item runs only while approval covers its latest version and hash. Its Tools are discovered live. A Tool's class is the admin's choice for that row, else the manifest's (`tool_classes`), else the class the server's read-only and destructive hints suggest, else `read` for a name that starts with a read verb and `write` for any other |

An Integration row is one instance of a kind. The row's `kind` names the catalog item it instantiates and its `name` is the instance's own slug; its `label` is the name an admin gives it, shown in the panel. One kind runs any number of instances: five ClickHouse clusters are five instances of one kind, each with its own URL, credentials, Tool curation, audience and grants. The instance slug is the secret key and the Tool namespace, so two instances never collide; a rename moves the stored secrets and the Tools take the new prefix. An admin names the slug and the label when it creates an instance and edits them later.

A Plugin reaches an Org's registry three ways, all ending in the same install: an admin installs a version from one of the Org's catalogs, uploads a `.guildplugin` file, or names a bundle URL; or a publisher pushes it with `guild-plugin publish` and an admin approves it. Install checks the bundle, starts it once, publishes it, approves its exact hash and adds a disabled row. The Org never depends on the source afterwards. Approval is the trust decision: the worker contains a Plugin's crashes and hangs, but it is not a sandbox.

A catalog is a static index (`guild-plugin-catalog/1`) listing plugins, their versions, each bundle's sha256 and its location. It lists code Plugins and MCP plugin bundles alike, and both install through the same path. Each Org keeps its own catalog list. A catalog is read from a public URL, or from a file in a GitHub or GitLab repository through the Org's own GitHub or GitLab Integration token, so private repositories work. A bundle the catalog names by relative path is read through the same source; its bytes must match the listed sha256.

An Integration speaks to two readers. Its manifest `description` is what the agent reads; its `README.md` (beside a built-in's plugin folder, or inside a Plugin's bundle) is the landing page an admin reads before installing. Each settings field may carry an `obtain` note on where the value comes from, shown beside the field. The Integrations page lists what is installed and what the catalog offers. A catalog entry's landing page is read from the bundle the catalog lists (checked against its sha256, never run) before any install. An installed Integration reads as one of: needs setup (a required setting or credential is missing), off, failing (its last call failed), active or idle. An admin can test its connection against what is stored at any time. Usage is read from the `integration.tool_called` audit events, which record the tool, caller, outcome, latency and error of every call.

The slugs `catalog`, `connect` and `sources` are reserved: they are addresses of the Integrations page.

Each Trait has one provider per Turn: the Integration instance the Org bound to it when that one is enabled, else the first enabled instance that declares it (built-ins, then Plugins by slug). The losers keep their other Tools.

An MCP Integration sends Guild's identity headers (`x-guild-org`, `-caller`, `-acting-as`, `-call-id`) unless the row turns them off. Its credentials are Integration secrets: a row with a header map sends each one in the header whose template names it; a row without one sends them as `x-guild-secret-<name>`. Every Tool the server serves, including one it starts serving later, is on until an admin turns it off; its class (the admin's, the manifest's, else the one the server's hints and the tool name suggest, `write` when unsure) and the reach ceilings decide who gets it.

Each Integration adds its Tools as `<slug>_<tool>`. This includes the selected providers’ Trait Tools. Each Integration exposes a `<slug>_list_tools` tool that returns the exact names and JSON schemas of its Tools the Turn may call. The Tools themselves are deferred: they are callable from a script, and the prompt carries the Integration's one-line index entry rather than their declarations. A `<slug>_guide` tool joins them only when the Integration's manifest names a skill in `skills`; the first slug is the guide, and the tool returns that skill's `SKILL.md`. Curation and the Agent's Integration list decide which of its Tools a Turn sees (see 002). Curation is per Tool: on or off, the approval rule, and the class. The admin sets the class on any Tool, not only an MCP one, because the class states what the credential behind the Tool can do: a key that cannot write marks its raw API Tool `read`. The Integration page's Access tab sets the audience and lists every Agent that uses it, with its warnings.

The HubSpot Integration offers read-class tools for marketing emails, delivery events, audience lists and memberships, campaign assets and v4 workflows. Email attribution keeps the creator, publisher and visible sender address separate from a list maintainer. CRM reads can return property history. These tools preserve complete JSON and the vendor pagination fields; callers follow each page to establish a full result. `hubspot_check_capabilities` probes CRM, email, events, lists, campaigns and workflows independently; the connection save gate checks contacts access only.

A Member can add their own MCP servers. Those servers are discovered at every Turn of that Member's Threads, and their headers are decrypted only at call time.

## Skills

A Skill's slug, description and body are English. Members read the catalog
across teams, so one language is the rule. Nothing checks it: the publish
path validates structure, not language, and the rule holds through review.

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

## Generated UI

An Agent with `generative_ui` on gets a `<generated_ui>` section in its instructions: when a UI block helps, the OpenUI Lang syntax and the signature of every component in the library (`packages/genui`). The section is static, so prompt caching holds across Turns. A spawned child's reply goes to its parent Agent, not a person, so its Threads never get the section.

The reply stays Markdown. A fenced block tagged `openui` renders in place as components, streaming as it arrives; every other fence stays code. The library is layout (Stack, Card, Grid, Tabs, Accordion, Modal, Carousel), content (Text, Metric, Callout, List, Facts, Tags, Progress, Steps, EntityList, CodeBlock, Image, ImageGallery), data (Table, BarChart, LineChart, PieChart, ScatterChart, RadarChart, RadialChart, StackedBar) and interaction (Buttons, FollowUps, Form and its fields: Input, TextArea, Select, Checkbox, RadioGroup, CheckBoxGroup, Switch, Slider, DatePicker, OptionCards, Chips, EditableTable). Programs may use `$variables` with `@Set`/`@Reset` and the built-in data functions; those act inside the block and send nothing. A program can only instantiate those components:

- `@ToAssistant(message)` sends the message as the Member's next message in the Thread, with the submitted Form's values as `name: value` lines. It queues while a Turn runs, like any send.
- `@OpenUrl(url)` opens an `http`, `https` or `mailto` link outside the app; any other scheme is dropped.
- `Query`, `Mutation` and custom actions have no provider: a block never calls a Tool, so every Tool still passes the Approval and exec-policy gates of a Turn.

Images in agent content — Generated UI and chat Markdown alike — come from three sources. A Guild attachment (`attachment:<id>`, the id `send_file` returns) and an inline `data:image` URL always show. A remote `http(s)` image follows the Org's **remote-image policy**, an admin setting on Settings → Security: `auto` (the default) loads it at once, `click` shows a placeholder with its description and full URL until the reader clicks, `never` shows only its description and full URL (the path and query are where an exfiltration attempt would sit, so the reader sees all of it). A remote request goes out without a referrer, but its host sees the full URL, so content that steers the model can carry data out in an image URL; the policy is the admin's trade-off. The policy reaches clients on the `workspace_identity` frame.

A block is a dialog: it takes one answer. Once any user message follows it in the Thread (a click on one of its buttons, or anything the Member typed), its buttons and fields settle, and the button whose message answered it stays marked. The state comes from the transcript, so it holds on reload and on every device; Tabs still switch and `@OpenUrl` buttons still open. Controls are also disabled while the block streams and wherever the transcript is read-only (Activity, traces). A block that renders nothing shows as its code.

## Apps

An Agent with the App tools works with the Apps its Member can open. The tools are `list_apps` (the Apps, their ids, owners, versions, functions and whether the Member may edit each), `read_app` (one App's manifest and Access list, and its page HTML written into the workspace so the Agent can edit it), `publish_app` (a new App, or a new version of any App the Member may edit), `set_app_access` (the Access list, which needs `edit`), and `call_app` (one data function, as the Member).

The Apps index rides the system prompt: one line per App the Member sees, with its id, version, functions and whether the Agent may edit it. An Agent whose tool list holds no App tool gets no index. Discovery therefore costs no call, and an Agent never has to guess that an App exists.

A publish checks every data function against that Member's reach before storing anything, so a wrong tool name or an Integration outside their audience is an error the Agent can fix.

A data function names an Integration slug, a tool (as `<slug>_list_tools` shows it), fixed arguments, parameters, and optionally its own class. `{"$param": "<name>"}` in the arguments marks where a parameter goes. A parameter has a type (`string`, `number`, `integer`, `boolean`) and may have `enum`, `default`, `required`, `max_length` (strings, 1,000 by default), `minimum` and `maximum`. A call that passes an undeclared parameter, misses a required one, or breaks a bound is refused. An omitted optional parameter drops its argument. A value is always data: it never becomes a key or another hole.

A function's class is its tool's, and the function may declare its own: `read`, `write` or `admin`. The declaration refines a bound that describes a whole API, not one call — a raw `<slug>_api` tool is `write` whatever request it makes — so only that tool takes a lower class. Any other tool keeps its own: a declaration there may only be stricter, and a publish refuses a weaker one.

The Apps page lists the Apps whose Access list reaches the Member, and an admin reads every App of the Org; the `app_list` frame keeps it live. Opening an App frames its page from a signed, ten-minute link, under a policy that gives the page an opaque origin and no channel out: no fetch or socket, no remote image, no popup, no form target, no navigation of the app. Scripts, styles and fonts load from three public CDNs and Google Fonts. Guild puts a bridge script first in the page; `guild.call(name, params)` posts to the framing client, which calls the function route with the viewer's session and posts the result back. The client answers only its own frame's window.

Every call acts for the viewer: their Integration audience ceilings (the script rule of 002), the Org's curation, `admin`-class tools for admins only, and the `integration.tool_called` event with `via: "app"`, the App and the function. A call whose function is `write`- or `admin`-class or curated `always_ask` needs the viewer's yes in Guild's own dialog, which shows the function, the request it makes (a raw API tool's method and path) and the parameters; the server refuses such a call without it. The viewer answers Decline, Allow once, or Always allow for this app. Always allow records a grant for that viewer, that function and that App version: the function's arguments are fixed and only its bounded parameters vary, so one yes covers every call it can make. A new version asks again, and the viewer clears their grants from the App's menu. Calls of one function that arrive while its question is open wait for the same answer. A function declared `read` runs without asking; `publish_app` tells the author to declare it when a fixed request only reads, and to prefer read-class tools first. One Member may call one App at most 120 times a minute, and a result over 4 MiB is refused.

An Agent's `call_app` runs the same function through the same rules, for the Member the Thread acts for, with the same audit event. A `read`-class function runs at once. A function curated `always_ask` asks in an interactive Thread. In coordinator-managed work and Routines it receives the unattended judge decision as a tool result (see 002). A `write`- or `admin`-class function goes to the Thread's approval mode, so `full_access` runs it and `ask` asks. The Agent never inherits a viewer's standing grant: the card is the Agent's question, and the page's grants stay the page's.

An App's Access list decides who may open it and who may edit it: an `edit` entry publishes a new version, renames the App and changes its list. The owner, or an admin, deletes it. A new App starts with an empty list, so only its owner opens it.

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
| Generated UI that calls Tools from the block (OpenUI `Query`/`Mutation`) | It would run Tools outside a Turn, past Approvals and exec policy; a button asks the Agent instead. Apps call Tools outside a Turn only through reviewed-at-publish data functions, as the viewer, with the viewer's confirmation for anything that writes |
| An App calling any Tool with any arguments | Untrusted page code would choose the call; a data function fixes the tool and the argument shape, and the page fills bounded holes |
| An App acting as its author | A shared App would hand the author's Integration reach to everyone who opens it |
| An Agent editing an App it may only open | The Access list is the rule: `read` opens and calls, `edit` publishes and shares |
| An Agent writing through an App without a card | A data function that changes data asks the Member, whether the page or the Agent calls it |
| The vendor's hosted gateway or chat client for Generated UI | Org traffic stays on the Org gateway, and the Thread stays on the member socket |
| Showing provider model ids | Members see the Org's aliases, and the id stays a wire identifier |
| An approval that survives a new version | A review covers one version and hash, so a change returns the item to draft |
| Removing unmanaged skill folders on a Machine | Only folders the sync wrote, marked by their provenance file, are its to remove |

## Open questions

- **App review.** Sharing an App needs no review: it never widens anyone's reach and its writes ask each viewer. An admin approval before `org` visibility, like a Registry item's, is the next gate if Apps start to matter.
- **App channels the policy cannot close.** WebRTC and DNS prefetch can carry data out of a page in some browsers whatever its policy says. The page's data is what the viewer may read anyway.

- **Skill scope.** Installs and pins are per Member, so two Members using one shared Agent may get different Skills from it. The alternative is a per-Agent skill set (`selected` or `all`), like the tool allowlist.
- **Bundle trust.** Registry bundles are content-addressed but not signed. Only desktop releases are signed.

## Desktop releases

A Release names signed desktop artifacts for one product version. GitHub hosts
six artifacts for four platforms; a server imports their checked metadata and
approves one complete version per channel for its paired clients. A stable stack accepts
stable versions; a develop stack also accepts `-dev.<build-number>` versions.
Every installer, listing and updater candidate is capped at the running server
version. An installation persists its own stable/develop preference across
sign-out and pairing changes. Native offers bind to the paired server, channel
and observed server version and are revalidated before installation.
Deployment release pairing imports the published tag for the exact version
reported by the running server when the image and release record the same
source commit. The approved version and all artifact rows
become visible together. The updater
manifest is absent if an approved updater artifact is missing. The database stores GitHub metadata and approvals; artifact bytes are hosted
only on GitHub.

Only a stable release on master changes the committed product version. Branch
and local builds stamp a temporary preview version in their build checkout.
The source commit is release provenance, separate from the version identifier.

Release workflows run on develop and master pushes. Stable version increments
originate on master and synchronize to develop through a version-only PR after
publication. Develop release retention keeps the newest ten, those younger than
fourteen days, and installation pins; stable releases are retained.

## Coordinator capability surface

Coordinator and reflection roles are provisioned before Integration or MCP resolution. No external capability is registered for either role. Coordinator Workspace tools reject a Machine target. Its `spawn` defaults to the same Agent and requires a trusted Input ID; a different accessible Agent can be selected. Workers discover their available tools progressively using the existing Integration catalog and disclosure tools, without a coordinator-selected schema whitelist. Reflection receives read/edit/write only, with an enforced operation budget.
