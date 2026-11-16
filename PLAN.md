## 0.6.109 — downloads stream, they do not buffer

The byte routes read the whole object into a `Buffer` before replying, so a
download held the file twice in the server process. `ObjectStore.getStream`
returns the SDK body as a `Readable`; every download route pipes it —
attachments, tool artifacts, releases, registry bundles. `get` keeps its
whole-buffer form for the callers that parse the bytes (a bundle, a media
reference, a file written into an env), and it is now built on `getStream`,
so one read path remains.

## 0.6.108 — a file reaches a machine as a reference, never as bytes

`write_file` is the model's tool: the model writes text it produced. It
carried text only, so `MachineExecutionEnv.writeFile` refused a `Uint8Array`
and a Gmail attachment or a Drive PDF aimed at a project folder failed with
"binary writes are not supported over machine dispatch".

Two wrong answers came first. `write_file` with `encoding: base64` put bytes
in a model tool, where a model that can emit base64 can silently corrupt a
file. `fs.write_raw_v1` moved the bytes out of the model's hands but still
pushed them down the socket — the same payload twice, once as JSON and once
as a frame, under a size cap the link should not need.

Files live in object storage already. So the machine gets a reference:

- `fs.fetch_v1` takes `{path, artifact_id}`. The engine pulls the artifact
  with its own session (`GET /api/v1/tool_artifacts/{id}`) and writes it at
  `path`. No file content crosses the socket.
- The server stages bytes it holds in the chat's artifact store
  (`chats/stage.ts` → `spillArtifact`) and dispatches the id.
- `MachineExecutionEnv.writeFile` still takes text or bytes: text goes
  through `write_file`, bytes go through the stager and then the fetch op.
- An engine without the op answers "unknown tool" and the write fails as
  `not_supported`: a refusal, never a file full of base64 text.

## 0.6.105 — a file a tool brings lands where the call says

`drive_get_file` and `gmail_get_attachment` returned bytes as a spilled
artifact. The model got pointer text naming `.guild/artifacts/<chat>/<file>`,
and in a plain chat nothing ever wrote that file: `read` answered ENOENT, the
sandbox had no copy, `download_attachment` did not know artifacts, and the
agent burned twenty turns on a dead path.

A tool now carries bytes as `ToolOutcome.file` — a path and the bytes. The
integration sink writes them through the call's environment before the model
sees the result, so the file is a real file the ordinary tools read. Both
Google get_file tools take a required `path`; there is no default destination.
The artifact outcome and its pointer text are gone: a result with no
destination is the only thing that spills.

`download_attachment` becomes `download`, and a chat file is now either kind:
an attachment or a spilled result, matched by id or by filename. It takes a
required `path` too, and refuses to replace a file unless `overwrite` is set.
One rule for a destination lives in `platform/domain/paths.ts` and one writer
in `harness/chat-files.ts`; both the tool and the integration sink come
through them.

`download` has no listing mode: `file` and `path` are both required. A call
with no arguments wrote nothing, yet it took an Approval card in a
project-bound chat, where the unattended batch contract does not apply, and
the judge flagged it as ambiguous. The file list already reaches the model
from a pointer, a child result, or the message itself.

The Approval card now shows the judge's reason. The verdict rode the
`approval_request` event and the client dropped it, so a member saw a card
with no word about why.

## 0.6.104 — a machine line names its shell

A call on a Windows machine was handed bash. WORKSTATION-A's executor answered every
call, but `bash` there is `cmd.exe` for a native folder, so the model's
`2>/dev/null`, `$HOME`, `ls` and `find` produced "The system cannot find the
path specified" and exit 255 — and nothing told the model the dialect. The
machine section listed label, id and online only.

A machine line now ends with the OS and the shell a call's `command` runs in
(`cmd.exe` on Windows, `sh -c` elsewhere), and the section says to write the
command in that shell's language, with the concrete difference: `dir`, `type`,
`where`, `%USERPROFILE%`, `2>nul`. The `\\wsl.localhost\<distro>\…` folder
exception stays named, because the workdir, not the OS alone, picks the shell.
A machine whose OS is unknown claims no shell: the line keeps its old shape.

`machine_list` renders the same lines, so a machine paired mid-turn carries the
same fact.

## 0.6.103 — an App function declares what its call can do

A Thread on `full_access` still asked for every `call_app`: a codemode script
that ran five data functions produced five Approval cards. The App's
functions all read through the HubSpot connector's raw `api` tool, which is
class `write` because the whole API is, and the function inherited that bound.
The gate also put its card ahead of the Thread's approval mode, so the
member's own choice never applied.

An App function is one fixed request, not the whole API. It now declares its
own class (`read`, `write`, `admin`); the tool's class is the default. The
declaration refines a bound that describes every endpoint, so only the raw
`<slug>_api` tool takes a lower class — a named tool keeps its own, and
`publish_app` refuses a weaker claim. `publish_app` tells the author to
declare `read` when a fixed request only reads.

The HubSpot connector now covers the API surface the raw tool covered, split
by class. Read: `search_contacts`, `search_companies`, `search_deals`,
`search_tickets` and `search_objects` (any other object type), each taking
HubSpot's own `filterGroups`, `sorts`, `properties`, `limit` and `after`;
`get_object`, `batch_read`, `get_associations`, `list_owners`,
`list_properties` and `list_pipelines`. Write: `create_object`,
`update_object` (it replaces `update_deal`, one way to change a record) and
`delete_object`. None of them is tied to this org's nouns: `sales_open` stays
an App function, not a tool. The raw `api` tool keeps the endpoints these do
not cover — batch writes, association writes, imports.

The App page and the Agent's `call_app` gate both read that class. The gate
then answers like the Integration envelope: a `read` function runs at once, an
`always_ask` curation asks whatever the mode, and a `write`/`admin` function
takes the Thread's approval mode, so `full_access` runs it.

## 0.6.102 — Windows draws its own caption bar

Windows had the native frame above a dark app — the same mismatch macOS had.
`tauri.windows.conf.json` (the platform config Tauri merges over the base one)
now sets `decorations: false` for the Windows build only, and the app draws
the 32 px caption bar: the name, the drag region and the three buttons, above
the columns and above dialogs, as the native caption is. An undecorated window
loses its resize edges, so the bar also carries eight edge and corner strips
that hand the drag to `startResizeDragging`. macOS keeps its floating traffic
lights; Linux keeps its native frame.

## 0.6.99 — the macOS window is content

The desktop window on macOS had the native title bar: a white strip above a
dark app. The window now uses `titleBarStyle: Overlay` with a hidden title, so
the page fills the window and the traffic lights float over it. The lights keep
the placement the system gives them, and the rail and the sidebar panel share
one seamless 28 px band (the rail's divider starts below it) that drags the
window and zooms it on a double click. The inset and the drag regions are off
on Windows and Linux, which keep their native decorations.

## 0.6.99 — the machine facts a worker cannot read itself

0.6.98 read machine liveness and the machine's home folder from the hub, and
the hub lives in the server process. Every chat runs in its own forked worker,
which holds no hub, so every machine read as offline: the prompt listed three
online machines as offline, and a call naming one failed with `machine
offline` before it reached anything.

The two facts are now a dependency (`MachineFacts`) with two answers: the
server reads the hub, and a worker asks the server over the same IPC channel
its machine dispatch already uses (`machine-online`, `machine-home`). The
worker's dispatch comes from its turn placement, not from a hub it does not
have. `worker-mode.test.ts` covers the path a plain chat takes: a call that
names a machine crosses IPC, the home comes back from the machine, and the
prompt does not call a live machine offline.

## 0.6.99 — a tool's class is the admin's call, not only an MCP one

The class of an integration tool decides two things: who may use it (the reach
ceilings of 002) and whether a call asks first. A compiled-in tool's class came
from its code declaration only, so an Integration whose credential cannot write
still classed its raw API tool `write`: every App function built on it asked,
every call, in every chat, and a `read` ceiling hid the tool entirely.

The Tools tab of an Integration now sets the class of any tool, MCP or not, and
the server takes it: `toolCurate` reads a curated class on every row,
`connectorToolClass` puts it ahead of the declaration, and the curation route no
longer refuses a built-in. The class states what the key behind the tool can
do — a read-only HubSpot token marks `hubspot_api` `read` — so an App reading
through it stops asking, and a `read`-ceilinged agent reaches it again.

## 0.6.98 — a tool call runs on any machine the member paired

Working on a machine needed a Project: the Project named the folder, and only a
Thread bound to one ran tools there. The four coding tools now take a `machine`
argument — a machine id, or a label unique among the caller's machines — and
that one call runs on that machine. `cwd` names the folder it runs in; without
it the call runs in the machine's home directory, read once per connection. No
folder carries from one call to the next, so a command writes `cd <folder> &&
…`, and the prompt says so.

A machine stays private to the Member who paired it: another member's id
resolves to `no such machine`, and the error names the machines that member does
own. Without `machine` a call keeps its Thread's own environment, so a
project-bound chat still runs on its project machine, in the project folder.

The `machines` prompt section lists label, id and live flag in every chat (and
says `none paired` when there are none), and `machine_list` reads the same list
again mid-turn. The tool card shows the machine label beside the tool name. A
write on a machine is journaled as `<machine>:<path>`, so two hosts never
collide on one path. The approval gate follows the target: a call that names a
machine counts as a machine call for the shell allowlist.

The codemode inline budget goes from 3500 to 4500 tokens: the coding tools carry
two more arguments, and the longest declarations are the first the budget drops.

## 0.6.96 — develop and master merged, one version

The two branches carried their own version bumps (0.6.94 on `develop`,
0.6.95 on `master`), so the merge had no single answer in `Cargo.toml`,
the workspace `package.json` files or the two lockfiles. The merge keeps
both trees and sets the product version to 0.6.96 with
`scripts/bump-version.sh`. `master` and `develop` now hold the same
tree; work continues on `develop`.

## 0.6.95 — the sandbox home is a tmpfs, not a workspace dir

A package store grew on the agent workspace volume: `HOME`, the
npm/pip/cargo caches and user installs all pointed at
`/workspace/.sandbox-home`, so one agent left a 183 MB chromium and
145 MB of pip cache there, 1.2 GB total. The home is now a 512m tmpfs at
`/home/sandbox` (`GUILD_SANDBOX_HOME_SIZE`). User-level installs and
caches work inside one container and die with it; project-local installs
under `/workspace` still persist. The agent prompt says the workspace is
a home, not a package store, and that egress reaches package registries
only. Agent tools ask for a timeout on any command that can block:
`agent_bash` has no default one, so one stuck command held a run for
21 minutes.

## 0.6.94 — web_fetch reads what firecrawl refuses

`web_fetch` failed on three kinds of URL that exist: JSON and plain-text
endpoints (`…/openapi.json`), pages that redirect into a single-page app, and
pages whose text is too thin for firecrawl's content heuristics. Firecrawl
answers all three with `SCRAPE_ALL_ENGINES_FAILED`, so the agent got an error
for a page that a browser opens. The new `curl-fetch` service
(`deploy/curl-fetch`, python + curl_cffi) is the fallback transport: the
firecrawl `web_fetch` retries a failed scrape through one browser-fingerprinted
GET and returns the body as text, with `engine: "curl"` on the web card. A
binary body is an error, never a cut file. `GUILD_CURL_FETCH_URL` (set by
compose) turns the fallback on; empty leaves firecrawl alone.

Two Google Workspace defects came from the same audit. `drive_get_file`
refused a `mime_type` on an uploaded file, while its own description said the
field is ignored — it is ignored now. And the `api` tool promised "the full
API surface" while the service account carries four read-only scopes, so an
agent learned the truth from a bare 403: the tool now names the granted
scopes, counts as `read`, and turns a scope refusal into a message that says
which scopes exist and who can add one.

## 0.6.93 — Apps are a capability an Agent uses

`publish_app` was the whole App surface: an Agent could create a page and
nothing else. It could not list the Apps that exist, so a thread that asked
about "the gearbox app" guessed at GitLab and Confluence. It could not read
an App, edit one it did not own, share one, or call one's data.

Apps now have four verbs. `list_apps` and the prompt's `apps` section show the
Apps the member can open, with their functions and whether the Agent may edit
each, so discovery costs no call. `read_app` returns the manifest and writes
the page into the workspace, ready to edit. `publish_app` takes the id of any
App the member may edit, not only their own. `set_app_access` replaces the
Access list (`edit` needed, no version bump: access is not page code).
`call_app` runs one data function for the member through the same reach,
curation and `via: "app"` audit as the page's call route; a `write`- or
`admin`-class function, or one curated `always_ask`, asks the member with the
Approval card even on the sandbox executor, and never inherits a viewer's
standing grant. The four new tools sit in a new `apps` code-mode namespace
with `publish_app`. Spec: `docs/specs/2026-11-11-apps-for-agents.md`.

## 0.6.92 — One sidebar, on every page

Five lists called themselves a sidebar and behaved differently: the chat,
project and settings panels resized and collapsed, the Apps list was a fixed
`w-72` aside, the Integrations list a fixed `w-[19rem]` block, and only the
chat header offered a way back. `views/sidebar/sidebar.tsx` now owns the
column: `Sidebar` draws the aside with the drag handle, `useSidebar` holds
the width and the collapse flag, and `lib/sidebar.ts` persists both, so a
resize or a collapse holds across pages. Every list renders inside it.

The rail's first slot toggles the sidebar: the Guild mark while it is open,
the expand button while it is collapsed. The workspace switcher left that
slot and joined the account menu, which now carries every signed-in server,
the add-a-server action, its per-server sign-out and Sign out itself. The
chat header no longer needs its own expand button, and the mobile drawer
keeps the mark alone.

## 0.6.91 — Sharing: every Team, and no boilerplate

The sharing dialog offered only the Teams the caller belongs to, so a
second Team was often missing. `GET /api/v1/access/teams` now lists every
Team of the Org for the picker, beside `/access/people`. The picker stays
open after a pick, so several Teams or Members are added in one pass.

The dialog is `Sharing` and says nothing else: the two paragraphs that
restated the title and each other are gone, the panel is wider, and the
level select no longer truncates. `GET /api/v1/access/teams` returns
`AccessTeam` (`id`, `label`).

## 0.6.87 — PostHog joins the shop

PostHog is a built-in Integration. One row points at one project: the
instance URL, the numeric project id, and a personal API key. The project id
is part of every request path, so a wrong id fails or reads its own project,
never a neighbour; the key carries the scopes, and the named tools only read.

The tools answer product questions: `query` runs HogQL over events and
persons, `list_insights`/`get_insight` and `list_dashboards`/`get_dashboard`
read the saved work, `list_feature_flags` shows the rollout, and
`search_persons` finds one person. `api` is the generic project API call.
Setup, scopes and the failure texts are in the plugin README.

## 0.6.86 — Access lists: one way to say who may read and edit

Agents and Apps now answer "who may reach this" the same way: one list of
entries, each naming everyone in the org, a Team, or a Member, at `read` or
`edit`. A `team` visibility and a grant table became one concept, so an item
is private when its list is empty and org-wide when the list holds the org
entry. The org entry is always `read`; only the owner and an admin delete.
A grant row now carries its level, and `edit` is live for the first time:
an editor edits an Agent and its list, and republishes an App.

One route pair serves both kinds (`GET`/`PUT /api/v1/access/{kind}/{id}`)
over `agent_access` and `app_access`; `agent_grants` and `agent_team_grants`
migrated into `agent_access` and are gone. The Apps page's share toggle and
the Agent form's visibility radios became one component
(`views/access/AccessPanel`), used by the Agent settings tab and the App's
Manage menu. A new Agent or App starts private; the create wizard no longer
asks about visibility. `GET /api/v1/access/people` offers the org's Members
to the picker.

An admin now reads every App of the Org, as it already did every Agent: the
Apps list and one App's read carry `can_edit` for the viewer, the Agent row
carries `can_manage`. Skills are unchanged: the catalog is org-wide and an
owner gates publishing, so a skill has no access list to edit.

## 0.6.85 — App confirmations: always allow, one question at a time

A dashboard built over `hubspot_api` (the raw API tool, `write`-class
whatever request it makes) asked before every call, and it calls one
function per month and page on every load: dialog after dialog. Parallel
calls also replaced each other's dialog, so earlier calls never settled.

The dialog now offers Always allow for this app: a grant per viewer,
function and App version (`app_grants`), checked by the call route in place
of `confirmed`. One yes is enough because the function's arguments are
fixed and only its bounded parameters vary; a new version asks again, and
Manage → Ask again before data access clears the viewer's grants. Calls of
one function share one open question, and the dialog shows the request a
raw API function makes (method and path) rather than "change data".
`publish_app` tells Agents that raw API tools ask viewers and to prefer
read-class tools.

## 0.6.84 — Apps: agent-built pages over live Integration data

An Agent can now publish a workspace HTML file as an App (`publish_app`):
a page Members open from the new Apps rail entry (`/apps/<id>`) and the
owner can share with the Org. The page reads Integrations only through
data functions declared at publish — one tool, fixed arguments, typed and
bounded `{"$param"}` holes — and every call runs as the viewer, through
the script API's reach rule, curation and audit (`via: "app"`). Writes ask
the viewer in Guild's own dialog on every call. The page is served from a
signed link with an opaque origin and no network (`connect-src 'none'`, no
remote images, popups or form targets); a bridge script Guild injects
first talks to the framing client over `postMessage`. The Apps list rides
the member socket (`app_list`, `guild_apps`).

Why not OpenUI with `Query`/`Mutation`: an App is a lasting, shared page,
and the objection to Turn-free Tool calls still stands; named functions
answer it, and a shared App acting as its author would leak reach. The
member-call path (`memberTool`/`runMemberTool`) moved to
`integrations/member-tools.ts`, shared by the script API and Apps. The
desktop CSP gained `frame-src` so the shell can frame App pages. Spec:
`docs/specs/2026-11-09-apps.md`.

## 0.6.83 — Integrations opens from Settings

Pressing the rail's Integrations button on the Settings tab left the reader on
Settings. A surface owns the whole address, but the patch that opened one kept
the tab it was opened from, so route state said "settings" while the URL said
`/integrations`. The settings normalisation then saw that tab, rewrote the
address back to `/settings/<section>` and dropped the page.

A patch that opens a surface now puts the tab on the chat root, so state and
URL agree. The settings normalisation also skips a route a surface owns, so a
surface address is never rewritten as a settings one.

## 0.6.82 — the preview pane actually renders

0.6.81 shipped a pane that drew a blank page. Two causes. The app's CSP
(`default-src 'self'`, no `frame-src`) blocks a frame from loading a `blob:`
URL, and a sandboxed frame cannot reach a blob the parent minted anyway. And
a deep link (`?preview=…` on a fresh session) rendered nothing at all: the
tab list was empty and the pane bailed before drawing.

Fixes: the byte routes accept a signed link (`/api/v1/preview_link` mints it,
`?preview=exp.sig`), served with its own `Content-Security-Policy: sandbox` —
the page keeps its inline styles and scripts, the frame still has an opaque
origin. `frame-src 'self' blob:` joins the app CSP so a blob PDF works too.
The addressed file rides into the pane as a tab of its own, so reload and deep
links show it. `srcdoc` stays as the fallback when the link cannot be minted.

PDF in the desktop shell is a note, not a frame: WebKitGTK has no PDF viewer.

## 0.6.81 — the preview pane, and a download that is a download

An attachment or an artifact chip opened a file by minting a blob and
saving it: `content-disposition: attachment` on both byte routes meant the
browser could never show the file it already had. The two routes now take
`?inline=1`, and the name travels in the RFC 5987 form, so a Cyrillic or CJK
filename arrives as itself (`safeFilename` keeps letters of any script; the
object key is unchanged in shape).

The thread gained a preview pane: the chat on the left, the open file on the
right, one tab per file. HTML renders in a sandboxed frame with an opaque
origin (no `allow-same-origin`), PDFs in a frame, images as images, text as
text; anything else offers the download. The pane is address state —
`?preview=<kind>:<id>` with `&full=1` for full screen — so a reload reopens
the same file and a navigation to another chat closes it. On a narrow screen
the pane fills the window.

# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a TypeScript cloud
server, a Rust local engine with shared protocol/core crates, and a Tauri
desktop client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. The
decision log is the changelog: each entry says what changed and why, newest
first. Code comments describe only the present.

## Where things stand

- **Server:** a TypeScript Fastify app on `pi-durable`, run by Bun with no
  compile step. The compose stack on `:18080` (`deploy/compose`) serves the
  API and the chat SPA baked into the image from `apps/desktop/dist`. State
  lives on the host services: Postgres db `guild`, ClickHouse for traces and
  usage, rustfs for objects. Agent workspaces ride a JuiceFS volume; tools
  run in gVisor sandboxes via `sandbox-runner`.
- **Version:** develop is at 0.6.49. Prod is a separate checkout
  (`~/guild-live`, branch master, port 18081), also at 0.6.49, and stays
  in supervisor mode; dev runs worker mode (`GUILD_WORKER_MODE=on`).
- **Clients:** desktop 0.6.49 is published on the dev updater manifest for
  all four platforms (six artifacts: Windows NSIS, Linux AppImage, macOS
  aarch64 and x86_64 DMG plus their updater bundles), minisign-signed.
  Installed clients pick it up on relaunch. Releases stay dev-controlled and
  deliberate.
- **Wire:** the client↔server contract is typed end to end, and
  `protocol/*.schema.json` is the contract: Rust and TypeScript are
  hand-written from it. Each client release is tagged `client-v<version>`
  (`client-v0.6.42` through `client-v0.6.49`), and `protocol/check.mjs`
  fails on a schema change that client cannot read. The model itself still carries migration history:
  dead stream variants, one event mapped twice, `Json` where a shape exists.
  A refactor defines the domain model before the wide release; the plan is
  `docs/plans/2026-10-28-wire-domain-model.md`. The wide release waits for
  it, because after the release every change costs a version step.
- **Product surface:** private threads and shared persistent agents; org
  skills with provenance; projects, machines and agent routines. Admin
  sections live inside Settings (`/settings/<section>`); there is no
  separate admin app. Observability is the Activity surface: conversations
  and runs read Postgres, the model calls inside a run read ClickHouse.
- **Quality baseline:** `scripts/check.sh` runs all of it in one pass:
  `cargo nextest run --workspace`, the TS server suite
  (`npm test --workspace apps/server`), desktop vitest, strict clippy
  (`--all-targets`), `cargo fmt --check`, the Windows compile check
  (`scripts/check-windows.sh`), `node protocol/check.mjs`,
  `npm run coherence` and `tsc --noEmit` over the server, desktop, wire and
  ui trees. A `biome.json` is committed but not yet run by the gate.

## Next steps (ordered)

1. **Finish the worker-mode soak and flip prod.** Dev serves turns through
   forked workers, so every agent turn rides this path. Still unverified:
   idle reap, and live approval, compaction and steering inside a worker
   turn. Prod stays on the supervisor until these pass.
2. **Enforce agent resource limits, or drop the field.** Every agent records
   `resources` (1 vCPU / 2 GiB / 256 pids / 50 GiB), but the sandbox runner
   ignores it and uses its own env defaults (2 vCPU / 2 GiB / 512 pids). The
   per-agent 50 GiB JuiceFS quota is the only limit that actually applies.
   Decide: pass `resources` into the sandbox spec, or remove the field.
3. **Harden the sandbox volume against a remount.** The runner detects a
   dead FUSE session by polling its volume roots, and the attach probe is a
   second guard. Replace both with one rule: every runner interaction with
   the volume goes through one helper, and `ENOTCONN` from that helper means
   the volume is gone. The reaction is the same as today (remove the
   sandboxes, restart the runner), but it fires on the failing call instead
   of up to 10 s later, and no new interaction can forget the check. Then
   drop the poll. The real fix stays open: mount the volume where the
   containers can re-resolve it (the entrypoint TODO), so a remount stops
   invalidating every container by construction.
4. **Set an org storage budget for shared agent workspaces.** The 50 GiB
   quota is per agent, and agent count is unbounded, so one org can fill the
   object store. Decide the budget and where it is enforced.
5. **Decide whether an archived thread can move to another agent.** Today a
   live thread moves with its transcript; an archived one has no such path.
6. **Decide machine identity after an OS reinstall.** A changed hardware
   fingerprint matches no row, so the machine registers as new and its old
   chats go dark. Candidates: derive the fingerprint from the firmware/board
   UUID, or give the user an explicit takeover on the machines page.
7. **Measure the rest of the long-thread path.** Composer typing is fixed.
   Initial load and scroll of the 3000-event dev thread were not measured.
8. **Cover the review gaps in the next loop:** Windows-only engine paths
   (compile-checked, never run), the desktop updater flow on a real install,
   and the integration connectors.
9. **Make `guild-plugin` a proper CLI with its own auth.** Today it is one
   Bun script (`packages/integration-sdk/bin/guild-plugin.ts`, run by path)
   whose `publish` needs a user session token passed by hand (`--token` or
   `$GUILD_TOKEN`). The registry accepts only session tokens (`gk_…` keys
   are the LLM gateway's), so CI would have to borrow a person's session.
   Wanted: an installable CLI (npm release of the SDK), a `login` that
   stores per-server credentials (or reads the desktop's
   `~/.config/guild/workspaces.json`), and an admin-minted, revocable
   publish token scoped to the registry endpoints for CI. Uploads stay
   inert until an admin approves the hash, so that token need not be an
   admin credential.

## Latest decisions

- **No image bytes in the database (2026-11-05).** A durable entry names its
  images instead of carrying them. A tool result's image parts and a member
  message's image attachments become `guild-media:<store>:<id>` — an artifact
  or an attachment row — and the bytes stay in object storage. The write
  side is one seam, the registry's `install`: every extension's tools are
  wrapped, so a tool Guild adds later (an integration, an MCP server, a
  client tool registered per turn) is covered without naming it, and a tool
  that already spilled passes through. The read side is the gateway's
  `dispatch`: image references resolve to data URIs before the provider call,
  through a process cache, because every step of a turn resends the history
  and the same images with it. `scripts/spill-entry-images.mjs` moves the
  rows that predate the rule.

- **A ThreadState frame is bounded by bytes, not rows (2026-11-05).** One
  prod thread shipped 6.7 MB of base64 PNG in every frame: a tool result's
  images rode its event at any size, and the 120-row window counted rows.
  A live turn republishes that frame on each buffer change, so the socket
  writer stalled behind it, the client's 15 s watchdog reaped the silent
  link, and every reconnect asked for the same frame again — a hang loop
  that reads as "long threads hang". Images now obey the same 64 KiB
  threshold as the result text they belong to (the durable entry keeps the
  model's copy; the event's was display-only and no client renders it), and
  the capture drops the window's oldest rows until the frame fits 512 KiB,
  with `has_more_events` saying the rest loads on demand.

- **A hidden tab keeps its socket (2026-11-05).** A background tab's timers
  are throttled by the browser, not stopped by the network, so its app-level
  pings drop to one a minute and the 15 s watchdog closed a healthy link
  once a minute. The watchdog now stands down while `document.hidden`, and
  the existing wake check owns the return to visibility.

- **The guild namespace: the admin's assistant reads the org (2026-11-05).**
  An admin's personal Agent now carries six script-callable tools under the
  code-mode `guild` namespace: `guild_overview` (member, agent and thread
  counts, today and month spend), `guild_members`, `guild_usage`
  (breakdown, series, totals over the usage events), `guild_threads`,
  `guild_thread_read` and `guild_agents`. The gate is the Agent's personal
  flag plus its owner's admin role, checked at each Turn
  (`guildToolsAllowed`), so no other Agent's Turn ever sees them. The reads
  reuse the admin's existing stores; one read is new, `ChatStore.listOrgChats`
  (the sidebar list is owner-only, so an admin could read a Member's Thread
  by id but never list it) plus its count aggregate. The usage reads reuse
  `UsageReports`; `UsageReports` now lives on the composition root and
  reaches the runtime as `usageReports`. Domain: 004's tools table and
  002's Activity and usage section.

- **pi-durable 1.5 (2026-11-05).** The server moved from the `pi-*`/Chord
  1.3.0 packages to 1.5.0 (pi-durable, pi-ai, pi-codemode, chord, all
  pinned; pi-schema and pi-telemetry come in with them). What changed for
  Guild:
  - *Storage.* `commit()` takes a group of batches per call (pi-durable
    now group-commits). The Postgres storage stores a call in one
    transaction, one seq per batch, each batch checked against the ones
    before it; the first batch Durable's checks refuse is not stored and
    the ones before it are (copy resolution moved into the checks, a
    failed database call still rejects the whole call). The live-projection
    cache is staged per call and written through after `COMMIT`. A commit
    receipt covers the call's consecutive seqs. Durable migration 7 adds
    the `sleeping` task status (1.4's durable sleeps and backoffs) and
    `durable_commits.stored`; a server older than this cannot open the
    database again. `pi.live` is document version 3 (`run.turns`,
    compaction `trigger`); the projection repair writes that shape and
    accepts every stored version.
  - *Events.* 1.5 removed `watchEvents()`; a renderer reads state.
    `chats/conversation-events.ts` derives the bridge's events from
    `Harness.observeConversation`, which gets every committed view change
    unfolded: run start/end from `pi.live.run`, the streamed answer and
    tool cards from `pi.live`, appended entries from the view window,
    inbox and compaction moves, and settled submissions read back for the
    run's inputs and items leaving the inbox. A run that ends faulted,
    orphaned, interrupted or at the restart limit (`pi.live.runFailure`)
    is the bridge's `task_failed`. A folding watch (`Conversation.watch`)
    was rejected: a run that starts and ends between two deliveries would
    lose its `run_end`.
  - *Smaller breaks.* `SessionEnd`, `Report`, `FileChange` are tagged by
    `kind`; `FileWatcher.close` is `stop` (the sandbox wire keeps `close`
    and maps it, and an untagged change from an older sandbox image is
    normalized); `onReport` gets one `Report`; `defineDoc` needs
    `checkpointWhen`. pi-ai no longer depends on TypeBox: the server's
    tool schemas still use it, now as its own pinned dependency
    (`typebox` 1.3.27) instead of an undeclared transitive one. Chord's
    optional `ws` peer is pinned to 8.21.0; a root `overrides` keeps the
    server's ws 8.22.
  - *Behaviour that comes with it.* Streamed partials and running tool
    output are stored at the next commit that reads `pi.live` or within
    1 s (a crash loses up to a second of stream, not 100 ms). A model
    request cut off by a restart counts as a failed attempt under the
    retry policy instead of being resent forever; a task cut off 5 times
    in a row ends (`restart_limit`) instead of looping.
  - *Not adopted, noted.* `settings.afterFailedRun: "continue"` and
    `submit({ type: "continue" })` cover what `drainIdleInbox` does after
    a failed run, but the drain also heals queues at startup and after
    other endings, so it stays. `Conversation.submit(tx, draft)` (admit
    inside a host commit) and `whenIdle: "reject"` fit child-result
    delivery, which already keeps one admission per request id. A
    read-only Harness could replace the SQL inbox reads of the
    harness-less server. `afterRun` run-end tasks could carry
    `agent_runs` settlement. `pi.live.runFailure.reason` could give a Run
    its failure kind. Tool schemas could move to pi-schema builders.
    Worker-per-chat still needs the scoped harness (plan C of the
    runs-follow-pi-durable spec): 1.5 has no multi-harness storage.

- **Code mode groups tools into namespaces (2026-11-05).** The `codemode`
  section listed every script-callable tool flat under one token budget,
  so the tail of the list dropped out silently and generic names (`send`,
  `list`, `close`) carried no context. Tools are now grouped: Guild's
  built-ins (`subagents`, `conversations`, `routines`, `skills`,
  `chat_history`, `files`), one namespace per Integration (its slug, with
  its description and guide hint), and one per user MCP server. The section
  lists every namespace before completing any, and scripts find the rest
  with `describeNamespace()` and `searchTools(q, { namespace })`. Calls
  stay flat (`tools.<name>`): pi-codemode namespaces group tools for
  discovery only. pi groups by name prefix and fixes namespaces at
  install, so `harness/codemode-namespaces.ts` pins each member by its full
  name and resolves the groups per conversation for each render and call;
  no tool was renamed. Nested `tools.<ns>.<tool>` objects would need an
  upstream pi-codemode change.

- **A chat counts as read only while its window has focus (2026-11-05).**
  Phone pushes went missing for answers and routine deliveries. The
  device side was fine: a probe signed with the server's VAPID pair got
  201 from Apple and showed on the iPhone, and the turn-end hook fires
  in worker mode for plain turns and routine runs alike. The cause was
  the read check: a finished turn pushes only if the owner's read marker
  has not passed it after a 4 s grace, and a client marked the open chat
  read whenever `document.visibilityState` was `visible` — true for any
  desktop window that is not minimized, a tab on another monitor, an app
  left open on the digest feed overnight. That client "read" every answer
  and the push was dropped. The read gate is now visible **and**
  `document.hasFocus()`, and a window regaining focus (or becoming
  visible) re-reads the open chat, so its dot clears when the member comes
  back. Reproduced on dev with an untouched open browser on a QA chat
  (`read == endSeq`, no send); regression test in
  `use-member-socket.test.tsx`.
- **Generated UI: the full component set, images, and an org remote-image
  policy (2026-11-05).** The library grew from 28 to 55 components to
  cover OpenUI's reference set: Accordion, Modal, Carousel, Steps,
  EntityList, CodeBlock, Image, ImageGallery, FollowUps, Scatter/Radar/
  Radial/StackedBar charts, a horizontal BarChart, and the inputs
  RadioGroup, CheckBoxGroup, Switch, Slider, DatePicker, OptionCards,
  Chips and EditableTable. `$variables` and the built-in functions are on;
  Query/Mutation stay off. The prompt section is now about 18.5k
  characters (~4.5k tokens), static and cached. Left out as duplicates of
  what exists: the vendor's composite card blocks, InlineHeader, Label,
  IconButton, MarkDownRenderer. Images: attachments (`attachment:<id>`,
  from `send_file`) and inline `data:image` always load; remote http(s)
  images follow a new org setting, `remote_images` (`auto` default,
  `click`, `never`), set on a new admin Settings → Security page and pushed
  on `workspace_identity`. Chat Markdown images follow the same policy
  (they used to be link placeholders only). A remote image is a request
  whose URL its host sees, so injected content can exfiltrate through it;
  `auto` is the product owner's choice, `click`/`never` are there for orgs
  that want the stricter trade-off.
- **Generated UI blocks take one answer (2026-11-05).** A form or a set of
  choice buttons stayed live after it was used, so it could be submitted
  again and again. A block is now a dialog: the first user message after
  its message (a click on one of its buttons, or anything typed) settles
  its buttons and fields, and the button whose message matches the answer
  stays marked. Derived from the transcript (`answersAfter` over the
  render blocks), so it needs no stored state and holds on reload and on
  every device; a click also settles the block locally at once, before
  the echo arrives. Tabs and `@OpenUrl` buttons stay usable. The prompt
  tells the agent to send a new block to ask again.
- **Generated UI: agents write OpenUI Lang blocks the client renders as
  components (2026-11-05).** Answers with several numbers, comparisons,
  trends or a need for structured input read badly as Markdown. An agent
  can now put an `openui` fenced block in a reply: a program in OpenUI
  Lang (Thesys, MIT, `@openuidev/lang-core` and `react-lang` 1.1.0, pinned)
  over Guild's own component library, `packages/genui`. That package holds
  the component schemas and the prompt section; the server teaches it in a
  static `<generated_ui>` block of the agent's instructions (about 2.5k
  tokens; no Tool calls, no `$` bindings, no builtin functions, to keep it
  small), and the desktop maps each component to a React renderer on the
  app kit (`views/genui`). The block rides the message text, so it streams,
  persists and syncs like any message: no new frame or event. A per-agent
  switch, `agents.generative_ui` (migration 0115), on by default and off
  for spawned threads, whose replies go to an agent. Kept out of the
  vendor's stack: the hosted gateway and Autofix (Org traffic stays on the
  Org gateway), `AgentInterface`/`fetchLLM` (the thread stays on the member
  socket), `Query`/`Mutation` (no `toolProvider`, so a block never runs a
  Tool past Approvals), and the dev-mode inspector that loads from a CDN
  (`lib/openui-devtools-off.ts`). `@ToAssistant` sends through the
  composer's send path with explicit text (queued while busy, the draft
  untouched) and appends the submitted form's values; `@OpenUrl` takes only
  http(s)/mailto. lang-core's postinstall reports installs to its vendor;
  npm 11 blocks it by default and the image sets
  `OPENUI_TELEMETRY_DISABLED`.
- **The chat picker offers only the member's own personal agent
  (2026-11-05).** Since admins see every agent (50da6ae8), an admin's agent
  list holds every member's personal "Assistant", and the composer's
  default took the first personal agent in it. An admin's chats then ran on
  another member's agent, with that member's Integrations: a Stripe check
  on prod answered "no Stripe" from a member's agent. The composer now
  offers the member's own personal agent and the shared agents they can
  use, and waits for the pushed profile before choosing the default. The
  Agents list still shows admins every agent, for inspection and analytics.
  002 had kept the pre-50da6ae8 rule that admins never see a personal
  agent; it now says what the code does. Open: the server still resolves
  an admin as owner of any agent, so the API lets an admin chat with or
  edit another member's personal agent; 002's manage row says admins manage
  non-personal agents only.
- **Discovered MCP tools are on by default (2026-11-05).** A tool an MCP
  server serves with no stored curation used to read as disabled, so a
  configured Stripe offered agents nothing until an admin switched each tool
  on, and an agent asked about Stripe answered that there was none.
  `toolCurate` now reads an uncurated tool as enabled for MCP rows as for
  connectors. What contains it is the class: the admin's, else the
  manifest's `tool_classes`, else the suggestion (server hints, read verb,
  else `write`), against the Agent's and audience ceilings, plus approvals.
  An admin's explicit off stays off. Also fixed the same day: an empty
  optional secret (Stripe's connected account) made MCP tool listing fail,
  so the turn skipped the Integration and the Tools tab erred.
- **"All available tools" covers Integrations through their audiences
  (2026-11-05).** After the 11-04 access change, `all` covered built-in
  tools only, and a personal Agent had to have each new Integration added
  by hand; a Stripe integration an admin set up never reached it. Now an
  `all` Agent's Integration list is derived at every read and has nothing to
  set: every enabled Integration that everyone who can use the Agent may
  reach, at the lowest ceiling the audience grants any of them
  (`allModeIntegrations` in `domain/integration-access.ts`). A personal
  Agent follows its owner's reach. A shared Agent gets only what its whole
  audience already holds, so it never widens access and never warns, which
  answers the spec's reason for rejecting `all` over Integrations. The
  derived list feeds the agent wire (REST and `agent_list`, re-pushed on the
  existing `guild_agents` notifies), the Turn scope and the Integration
  Access tab. Stored entries of an `all` Agent are kept but unused, and a
  submitted list is ignored. The settings page shows the derived list
  read-only and hides the editor. Switching to Choose tools starts from the
  derived list.
- **Test connection tests the form, not only what is stored
  (2026-11-05).** An admin pasted a Stripe key and pressed Test
  connection before saving; the test ran against the stored row, which
  had no key, and Stripe answered 401. `POST /admin/integrations/:id/test`
  now takes the form's unsaved `{ config, secrets }` and lays them over
  the stored row in memory, writing nothing; the configuration page sends
  them while the form is dirty. An MCP test names missing required secrets
  by label before calling out. Enabling an MCP plugin required every
  secret field, including optional ones (Stripe's connected account); it
  now requires only the required fields.
- **MCP plugins: the SDK wraps a remote MCP server, built in or published;
  Stripe is a built-in (2026-11-05).** Adding a known vendor MCP server
  (Stripe) meant every admin typing its URL, header shape and key format
  into Add MCP server. `@guild/integration-sdk` now has a second plugin
  shape, `mcpIntegration({...})`: metadata, settings fields, `mcp: { url,
  headers, envelope }`, optional `tool_classes`, and no code or tool list.
  The same module serves two ways. Built in: listed in
  `integrations/index.ts` like any built-in; the loader validates it at
  startup as a registry manifest (header templates must name secret
  fields) and `approvedManifest` returns it first, so every MCP path (stub
  create seeding `config.mcp`, live discovery, curation, test connection)
  serves it with no publishing. Its slug is reserved against registry
  items, uploads, catalogs and org MCP servers. Published:
  `guild-plugin pack` writes a code-free bundle (manifest, README, logo)
  that installs as an MCP item, and the shop now reads such an item's logo
  and readme from its bundle. A same-day `catalog/` folder of
  manifest.json stubs in this repo was dropped for this. Discovered tools
  arrive disabled. That exposed a class hole: an MCP tool with no curated
  class and no manifest declaration ran as `read`, so `stripe_api_write`
  would have passed a read-only ceiling. The fallback is now the
  suggestion the create form already used (server
  `readOnlyHint`/`destructiveHint`, then a read verb in the name, else
  `write`), at turn time and in the tools listing. Header templates carry
  literal text (`Bearer {stripe_key}`) so the admin pastes only the key;
  an optional secret makes an optional header (`Stripe-Account`). A
  built-in's `config.mcp` is copied into the row at create, so a later
  release that changes the server URL or headers does not reach existing
  rows. Known gap.

- **Integration access: audiences and explicit Agent Integration lists
  (2026-11-04).** An enabled Integration used to reach every Member, gated
  only by role × class (`member` read, `admin` all) and each Agent's
  allowlist, where `tools_mode = all` picked up every Integration. Nine of
  ten built-ins call their vendor with one shared token, so that gate was
  the only boundary, and it could not keep HubSpot (revenue, deals) to
  Sales. Now an Integration has an audience (`org` with a ceiling, `team`
  grants with ceilings, or `admins`; new ones start at `admins`), and an
  Agent lists its Integrations explicitly, each with a class ceiling. The
  Agent's list supersedes the caller: whoever can use the Agent reaches what
  it lists. The audience is checked when someone adds or raises an entry.
  Where an Agent's audience is wider than an Integration's, the Agent and
  the Integration's new Access tab warn, naming who gains what; nothing
  composes the two at call time. `all` covers built-in and Trait tools
  only. The per-role `tool_policy` is gone. The script API uses the
  caller's own audience ceiling. Migration 0114 keeps today's reach:
  existing Integrations become `org` at the class members had, `all`
  Agents list every enabled Integration, `selected` Agents list the
  Integrations whose tools they selected; shared Agents take the member
  ceiling, so an admin using a shared Agent may lose a write tool until
  someone raises its entry. Live state: `agent_list` carries
  `integrations` and `integration_warnings`, and a new `integration_access`
  frame carries what each Member may attach (`guild_agents` notify on the
  new tables). Google Workspace no longer falls back to the admin email
  when a call has no Member identity: it refuses. Known gap: a shared
  Agent's Workspace carries what one caller fetched to the next. Spec:
  `docs/specs/2026-11-04-integration-access.md`; phases 2 (several
  connections per vendor) and 3 (member identity by impersonation or
  vendor permission checks) are open.

- **Reading an agent never creates a thread (2026-11-04).** Listing an
  agent's threads created the reader's Main thread, so an admin who opened
  another Member's agent got an empty "Main thread" that stayed in their
  thread list for good. `ensureDefaultThread` is gone: the Main thread is
  made only with the agent, for its creator. A turn sent to an agent without
  `thread_id` goes to the caller's Main thread, or to a new thread of theirs
  when they have none. Migration 0113 deletes Main threads that never held a
  turn (no events, runs, durable conversation or child threads) — 11 on dev,
  10 on prod.

- **Each stack owns its JuiceFS filesystem; the sidecar holds the volume
  (2026-11-04).** At 16:15 a dev deploy recreated the server and the runner
  together, the only users of the `guild_workspaces` bind volume. Docker
  unmounted the volume, the unmount propagated through the shared host
  directory, and the FUSE mount at `/mnt/guild` went down. Prod went with it:
  prod never set `GUILD_WORKSPACE_HOST_DIR`, and the entrypoint hard-coded
  `guild_meta`, so dev and prod were one filesystem (same host directory,
  metadata database and bucket). Now: `.env` names each stack's host
  directory, metadata database, JuiceFS volume, bucket and Docker volume with
  no defaults; the entrypoint honours `GUILD_JUICE_META_DB` and refuses a
  host directory that holds another volume; the `juicefs` service mounts
  `guild_workspaces` itself, so the volume never loses its last user; the
  JuiceFS settings reach only that service (`juicefs.env`). Dev moved to its
  own filesystem (`/mnt/guild-dev`, `guild_meta_dev`, bucket
  `guild-workspaces-dev`, volume `compose_guild_workspaces_dev`), its 370 MB
  of agent folders copied and removed from prod's; prod kept its filesystem,
  pinned in its `.env`. Dev's volume uses a RustFS user scoped to its bucket
  (`guild-workspaces-dev`, in `juicefs.env`). Open: the same for prod; the
  orphaned `compose_guild_workspaces` volume record, which still binds
  `/mnt/guild` in prod's shared peer group and must not be removed while
  prod is mounted there (unmounting any peer unmounts them all, which took
  prod's host mount down once);
  the 12 KB `agents/01a17457…` folder in prod's filesystem that matches no
  org; prod picks up the compose change with its next deploy.

- **A Turn's files reach the agent wherever they arrive from (2026-11-04,
  branch `spike/pi-durable-runs`).** `/tmp/attachments/<run>/` was written
  once, before the run's first tool call, from the user message nearest the
  run's start, so files of a steer or child result placed mid-run never
  landed. It now covers every input the run took (member messages and
  child results since the previous run's last answer), and each tool call
  adds files placed since. `download_attachment` only listed the chat's own
  attachments, so a parent could not fetch the files its child results
  carry (they belong to the child's chat). It now also reaches those, and
  the child-result text says to fetch them with it.

- **A Run is the record of exactly one pi-durable run (2026-11-04,
  branch `spike/pi-durable-runs`).** `agent_runs` no longer infers a run's
  end from the first answer without a tool call. A `beforeRequest` hook
  opens the row before the run's first model call, taking over the queued
  row a spawn, send or routine created for its input; the input's request
  id is that row's id. The bridge's `run_end` settles it from the run's last
  answer. A steer or child result taken after an answer is now part of the
  same Run, and the answer delivered upward is the last one. Submit, the
  agent turn route and child delivery no longer open runs, and delivery
  drops its advisory lock: pi-durable's request id keeps a result to one
  admission. A spawned child shows `queued` until its run starts. Spec:
  `docs/specs/2026-11-04-runs-follow-pi-durable.md`.

- **Runs follow pi-durable: findings (2026-11-04, branch
  `spike/pi-durable-runs`).** `agent_runs` infers a run's end from the
  first assistant message without a tool call, so a record can close while
  pi-durable's run continues on a steer or child result. That run's later
  answer never reaches the parent. pi-durable's turn is `pi.live.run`
  (the bridge's `run_start`/`run_end`), and an input waiting at the final
  boundary starts a new run. Plan A: make `agent_runs` a projection of that
  run, keeping its ids, frames and URLs. Native task-owned subagents
  (plan B) need one harness for a whole agent tree. pi-durable assumes
  one harness per storage, with no cross-process notification, and
  worker mode runs one harness per chat. B is therefore a product decision
  (one worker per tree) or waits on upstream (plan C). Details:
  `docs/specs/2026-11-04-runs-follow-pi-durable.md`.

- **Integrations are their own page: installed vs catalog, landing pages,
  setup notes, usage (2026-11-04).** The Settings → Integrations section
  (a card grid in the settings column, with Catalogs, Install plugin and
  Traits as side pages) is replaced by an admin rail surface,
  `/integrations` (`views/integrations/`, route contract in
  `integrations-route.ts`; old `/settings/integrations/...` links redirect).
  It is a list pane (Installed, grouped needs attention / on / off with a
  status line each; Catalog, grouped by where an entry comes from) beside a
  wide page. An installed integration has Overview (what needs the admin,
  30-day usage, its tools, which shared tools it answers, with "Use this
  one"), Configuration (each field beside its "How to get it" note; Save
  tests first; Test connection checks what is stored), Tools, Usage and
  About (README, update from a catalog, remove). A catalog entry has a
  landing page: README, what you will need, tools, source and hash, one
  Install that lands on Configuration. Content comes from the plugin: a
  `README.md` (beside a built-in, inside a bundle; `guild-plugin pack`
  includes it) and an `obtain` markdown note per field (SDK
  `IntegrationField`, wire `FieldSpec`); the bundle manifest now carries
  `tools.declared` (name, class, description) so a catalog page lists
  tools without running the plugin. All ten built-ins ship a README and
  notes. New admin endpoints: `POST /admin/integrations/:id/test`,
  `GET /admin/integrations/usage` (per slug, 7 days) and `/:id/usage`
  (totals, by day, tool, person, recent failures), and
  `GET /admin/integrations/catalogs/:id/plugins/:slug` (the bundle read and
  sha-checked, cached by hash, never run). Usage reads the
  `integration.tool_called` audit events, which now record `ms` and the
  capped `error`; a partial index serves them (migration 0112). The list
  stays an admin editing list and usage windowed analytics (005), so no
  socket frame. The slugs `catalog`, `connect` and `sources` are reserved.
  Also fixed the same day: a catalog plugin counts as installed only while
  the org has its row, so a removed plugin installs again.

- **Integration plugins ship as registry bundles; orgs install them from
  catalogs (2026-11-04).** The gitignored `integrations/private/` folder
  (same day, below) tied company plugins to a server checkout and an image
  rebuild. A plugin is now its own repository built against
  `@guild/integration-sdk` (`packages/integration-sdk`: the contract types,
  the request helpers, and the `guild-plugin` CLI). `guild-plugin pack`
  bundles the plugin and the SDK into one `plugin.js` and writes a
  `.guildplugin` (manifest.json with `runtime: "code"`, plugin.js,
  logo.svg). The server runs an approved code bundle in a worker thread
  (`code-plugins.ts`, `plugin-host.mjs`) loaded from the org's registry
  object, checked against the approved hash, cached per hash — no rebuild,
  no copy; the worker contains crashes and hangs but is not a sandbox, so
  approval of the exact hash is the trust decision. Connectors are per org
  now (`connectors.ts`: built-ins, then the org's approved code plugins).
  Installs go through one path (`plugin-install.ts`: check, start once,
  publish, approve, disabled row) from three sources: a catalog version, an
  uploaded file, a bundle URL; `guild-plugin publish --approve` is the CI
  push. A catalog is a static `guild-plugin-catalog/1` index (plugins,
  versions, sha256, bundle location); each org keeps its own list in org KV
  (`GUILD_DEFAULT_PLUGIN_CATALOG` seeds it), read from a public URL or a
  file in a GitHub/GitLab repository through the org's own GitHub/GitLab
  integration token, so private repositories work. Trait providers are
  bound per org (org KV, Integrations → Traits); unbound, the first enabled
  declarer wins. Superproxy moved to `~/guild-plugins-acme` (its own
  repository and the private catalog) and installs as a code plugin.
  Deferred: publisher signatures, MCP integrations providing traits, and an
  npm release of the SDK (plugin repos link it from a Guild checkout).

- **The conversation's inbox is the only queue; thread events are only
  what happened (2026-11-04).** Pending inputs had three homes: pi-durable's
  inbox, a `thread_events` echo marked `queued` (the desktop chip, moved on
  placement, deleted on withdrawal), and for child results a staging table
  (`child_result_deliveries`, added earlier the same day) whose batch was
  merged into one inbox item. Every sync between them was a bug source. Now
  every waiting input is one item in pi-durable's own tables (`submissions`
  + the `pi.inbox` document), never merged: a member message is a
  `guild.member-message` input whose user row is projected under the
  message id at placement; a child result is a `guild.child-result` input
  keyed by the child run id, and a sweep re-delivers ended child runs with
  no submission and no card. Batching child results is a placement rule:
  `steeringMode: "all"` takes every queued steer at one boundary (a
  member's several steers too). The ThreadState frame gained `queue`
  (`QueuedInput`: message / turn / child_result), read by SQL from the
  inbox tables (`storage/postgres/inbox.ts`) so the harness-less server can
  answer in worker mode; `inbox_update` republishes the view, and the
  desktop builds its chips from it (steer/withdraw only on member
  messages). `turn_commands.accept` no longer writes a row. Migration 0111
  drops `child_result_deliveries` and clears `queued`/`mode` on existing
  user rows; the wire still accepts those two fields. `turn_commands` stays
  the HTTP idempotency and message-id → submission record.

- **Every thread row with a message is projected from the conversation
  (2026-11-04).** The rule "what a thread shows as conversation, the agent
  has in its conversation" had six more breaks, all now projected from
  journal entries:
  (1) Child results. They were `thread_events` rows written up front, then
  sent as a steer that merged into any pending steer, including a member's
  queued message: withdrawing that message dropped results already marked
  consumed, and a card showed before the parent had the result. They are
  now inputs whose cards are projected at placement (the staging table
  this entry first added is superseded by the entry above). A stop
  withdraws queued inputs, so a queued result is withdrawn first and
  written back as an entry: it stays in context but starts no run.
  (2) Subagent and routine prompts were echoed straight into
  `thread_events`; they are now `guild.posted-turn` inputs whose user row
  is projected at placement. The turn-tools adapter dropped the new
  `entry` field and is fixed.
  (3) A failed submit left the member's echo forever, and a retry under
  the same id only got the failed ack. If the conversation never admitted
  the input, the echo and the command row are deleted, so a retry starts
  over. The 15-minute expired-command sweep does the same. An admitted
  input stands.
  (4) A UI close, (5) an ancestor's `send` to a grandchild, and (6) the
  workspace-conflict notice wrote rows into a chat whose agent never saw
  them. Each is now a `guild.notice` write. Its text is a user message
  for the agent, and its row (`child_closed`, `child_spawned`, log-only
  `system_message`) is projected from it. `deliverMessage` became the
  general `writeEntry` routed op.
  The client event-append route (`POST /threads/:id/events`, alias
  `POST /chats/:id/thread`) is removed; no client used it. Readers now
  agree on one text per event type (`threadEventText`): `thread_history`,
  thread search, the tree read tool and the admin reader include child
  results, child turns, closes and compaction summaries. Search chunks
  include child results, and a posted agent message is indexed when it is
  projected, since a routine feed has no run to index it. Results queued
  in `thread_events` before this deploy are not redelivered.

- **Org-specific integrations live outside the repo; admins add MCP servers
  from the UI (2026-11-04).** Two paths now carry integrations that do not
  ship with Guild. (1) Private plugins: the loader imports every
  `apps/server/src/integrations/private/<folder>/integration.ts` at startup,
  ahead of the built-ins, so a private trait provider wins its trait. The
  folder is gitignored (an org keeps its own repository there) and plugins
  import only `integrations/sdk.ts`, so the server's internals can move
  without breaking them. A slug clash refuses to start. Superproxy moved
  there: it is Acme infrastructure, not a product integration. A
  checkout without the folder serves the built-ins only, and rows of a
  missing plugin are skipped. (2) Org MCP servers: Settings → Integrations →
  Add MCP server takes a URL, credential headers and the identity-envelope
  switch, probes the server, and lets the admin pick tools and classes. The
  create publishes a generated registry manifest and approves it in the
  same step (the admin is the reviewer), then stores the enabled row. An MCP
  row's `config.mcp.headers` maps header names to `{secret}` templates, so
  third-party servers get `Authorization: Bearer …` from the encrypted
  store instead of `x-guild-secret-*`; `config.mcp.envelope: false` drops
  the `x-guild-*` identity headers. An MCP tool's class is now admin state
  (`config.tools[<tool>].class`, over the manifest's declaration): the
  probe suggests one from the server's `readOnlyHint`/`destructiveHint` and
  a read verb in the name, else write. `tools/list` follows `nextCursor`.

- **A posted agent message is a conversation entry (2026-11-04).** Rule:
  what a thread shows as conversation, the agent has in its conversation.
  `send_message` appended an `assistant_message` straight to
  `thread_events`, so a routine feed's posts (and the opening message of a
  thread an agent opens) were never in model context: compaction of a prod
  feed summarized one user line as "no prior history", the context meter
  never counted them, and the agent had to `thread_history` its own posts.
  A delivery is now a `guild.agent-message` write submission into the
  target chat's conversation (`deliverMessage`, routed like `deliverSteer`
  to the chat's owning worker): it lands at once when idle, else at the
  turn boundary. The entry carries an assistant message with zero usage;
  the projection appends its transcript row as a turn of its own, and the
  context meter adds estimates of entries after the last measured request,
  as pi-durable's compaction trigger does. Posts written before this change
  stay display-only; the feed prompt still points at `thread_history` for
  them. The other gaps of the same rule are closed by the entry above.

- **The domain model is written down, in numbered documents (2026-11-03).**
  `docs/domain/000`–`005` name Guild's concepts and the rules each keeps:
  principles, the domain model with rejected concepts and a glossary,
  access, execution, capabilities and live state. Each document builds only
  on the ones before it. They describe the code as verified on this date,
  where the 2026-10 specs had drifted (no `project_*` tools, thread types
  `user|subagent|routine`, only `AGENTS.md`/`MEMORY.md` ride the prompt,
  routine kinds `cron|once`, admins read but never write a member's
  thread). Known gaps found while writing are listed at the end of 002,
  003 and 004. A change to a concept or a rule updates its document in the
  same commit.

- **Observability reads conversations and runs, top-down (2026-11-04).**
  The Activity surface is the history browser for managers. Its base layer
  is the conversation (one chat) and the run (one agent turn); the call
  analytics stay behind them. A conversation row joins the chat, its owner,
  its agent thread and the run and message counts, so an admin sees the
  whole org and a member only their own rows. The conversation page reads a
  page of message events and the runs that overlap it, and groups them:
  the trigger message, one run row ("N steps", status, duration, tokens),
  then the agent's reply. The run row opens the run detail; the run detail
  names its thread and links the parent thread, and shows the trigger
  message above the transcript. `/api/v1/activity/conversations` is the new
  read; the old `/activity/sessions` stays as the released-client alias.
  The tabs read Conversations, Runs, Model calls, in that order. Access is
  the existing owner-or-admin rule: an admin reads every chat, a member
  only their own.

- **A routine's notification names the chat it wrote to (2026-11-04).**
  A routine run is a hidden transcript, and the run-end push opened that
  transcript. The delivered message lived in another chat, so the push
  never named it. A finished turn now resolves its push target first: a
  routine run pushes the chat its `send_message` landed in (the feed, or the
  chat the run opened in `new_chat` mode), titled after the routine, with
  the body "A routine posted a message."; a run that sent nothing pushes
  nothing. Every other chat pushes itself. `agent_threads` carries the
  link: a delivery points its chat's `origin_thread_id` at the run thread
  behind it, so `routineDeliveryChat` answers per run, and the notifier's
  read check and coalescing run on the delivered chat's marker.

- **A routine delivers into one chat, marked in the list (2026-11-04).**
  Every `send_message` from a routine run opened a new chat, so an hourly
  routine filled the sidebar with near-identical rows. Routine runs already
  stay hidden and end `silent` when they send nothing; the noise was the
  delivery. A routine now has a `delivery` (migration 0109):
  `thread` (the default) appends each message to the routine's feed chat,
  one per (routine, user), titled after the routine and title-locked;
  `new_chat` keeps one chat per message. `agent_threads.routine_id` marks
  any chat a routine delivered into (backfilled from the origin run thread),
  and `routine_feed` names the feed; a unique partial index keeps one feed,
  and a concurrent first delivery reads the winner back. A feed whose chat is
  archived, deleted or closed is retired and the next delivery opens a new
  one. A feed that is mid-turn gets a separate marked chat, so a delivery
  never interleaves with a live turn. Delivered messages are journal events,
  not model context: the feed's prompt block (`<routine_thread>`) tells the
  agent to read them with `thread_history`, and the run's `<routine_run>`
  block tells it to write each message to stand on its own. The REST and
  socket `Chat` row carries `routine: {id, name}` (`ChatRoutine`), and the
  sidebar row leads with a repeat icon. The routine page sets the delivery
  mode, and so do `create_routine` and `update_routine`.

- **An OIDC user's account is rechecked at the IdP on activity
  (2026-11-04).** A login proved the account existed; nothing after it
  did. A Google account disabled at the provider kept its Guild session
  (30-day sliding expiry), its machine pairing and its API keys until an
  admin deleted the user. Now the login asks for offline access and stores
  the refresh token (`oidc_identities`, encrypted with the master key), and
  `platform/idp-recheck.ts` replays it — at most once per interval, and only
  for a user who is active.
  - *The hook is activity, not a timer.* `requireUser` and the member
    socket's per-message revalidation note the user; a per-process memory
    map makes that a read, and the store's `claimRecheck` makes one call per
    user per interval across every worker.
  - *The request is never blocked.* The recheck runs in the background, so
    an IdP outage cannot fail a request. A refused grant (`invalid_grant`:
    suspended, deleted, or app access revoked) revokes the user's sessions,
    pairing tokens and API keys and bumps `auth_generation`; the next call
    answers 401 and the client signs out through the existing 401 policy. A
    transport failure or 5xx is not evidence against the user: nothing
    changes and the next interval retries.
  - *Interval* is `GUILD_IDP_RECHECK_SECONDS` (default 900, `0` disables).
    A user whose provider issued no refresh token has no link and is
    skipped — they get one at their next login. A re-login rewrites the
    link and counts as a check.

- **Full review applied: trust boundaries, one home per layer, exact
  machine files, desktop stores (2026-11-03).** A six-lane review (server
  runtime, platform/hub, services, desktop, Rust, cross-cutting) found two
  trust-boundary bugs and a set of structural ones; this entry records the
  rules the fixes set.
  - *Agent workspace files never follow sandbox symlinks.* Server reads and
    writes under an agent workspace go through `agents/workspace-fs.ts`:
    segment `lstat`, `O_NOFOLLOW|O_NONBLOCK`, a regular-file check on the
    opened file, real-path containment, byte caps (config 128 KiB with a
    marker). The sandbox writes that volume, so a planted link must never
    resolve in the server's namespace.
  - *Machine file ops are exact.* The server's machine file adapter reads
    through `fs.read_raw_v1` (exact bytes, 8 MiB cap, `too_large` instead of
    a cut) and `fs.stat_v1`, never the model's paged, text-only `read_file`,
    so a read-modify-write edit cannot write a large file back truncated. An
    engine without the ops fails file access as `not_supported`.
  - *Runs and turns.* Spawn, send and routine runs start through
    `startThreadRun`, which refuses a deleting or inactive agent and a
    requester who lost access; a routine runs only while its creator can use
    the agent (a scheduled occurrence fails at once with a notice, a manual
    run answers 403). A turn's idempotency check runs before the agent
    binding and covers `agent_id`. `send_message` dedupe is per user and
    chat of origin. Grant roles are `owner|user`; a row with another role
    grants nothing.
  - *Outbound URLs.* `integrations/ip-guard.ts` is the one address
    classifier (hex IPv4-mapped IPv6, CGNAT, this-network, multicast
    included); the user MCP guard and the `web_fetch`/`map` guard share it.
    Integrations share one `fetchTimeout`, `readBodyCapped` and
    `requestJson`.
  - *Layers, enforced.* `arch-layers.test.ts` knows every top-level folder;
    no layer imports the composition root; the DAL imports nothing above
    it; durable tables are read only through `storage/postgres/queries.ts`;
    platform-table SQL outside the DAL is a shrinking allowlist. `src/http`
    moved under `platform/http`, `platform/integrations` into
    `src/integrations`. The runtime is built from `RuntimeDeps`
    (`platform/stores.ts`, once per process) and its turn placement lives in
    `harness/turn-backend.ts`. Migration 0105 owns `chat_conversations`;
    `PlatformContext.start` is the one bootstrap. Worker IPC has one turn
    input, a ref space per direction, error codes kept across the fork,
    timed-out requests and the config passed as JSON; the core turn flow is
    tested in both placements.
  - *One DAL per lane.* `agents/store/` is the agents lane's data access
    (bindings, chunks, delivery, events, occurrences, routines, run-finish,
    stale-runs, tree, workspace-turns beside the store modules); the agents
    services keep only logic, and the scheduler's claim transaction passes
    its client down. `arch-layers.test.ts` counts `agents/store/**` as DAL
    and fails on any platform-table SQL outside the DAL: the allowlist is
    gone.
  - *Migrations.* An applied migration is never edited unless
    `migrations/amended.json` lists the edit with the hashes it replaces;
    the runner adopts the current hash for those and warns on any other
    drift, and a test holds every migration shipped with the last client
    tag to its released bytes. 0022 (comment) and 0092 (fresh-schema guard)
    are listed.
  - *Agent store.* `AgentStore` keeps the agent rows and the access check
    (`AgentCatalog`) and exposes `grants`, `threads`, `tree`, `runs`,
    `notices` and `lifecycle` from `agents/store/`; callers name the
    sub-store, and its `ChatStore` is injected. Recovery, the approval gate
    and the thread-history tools read through the platform stores, so the
    SQL allowlist names only the agents lane. An agent-list push burst costs
    three reads for any number of members (`AgentGrants.visibleAgentIds`).
  - *Push.* The NOTIFY channels are one typed parser table, per-key pushes
    share `KeyedChain`, and `DEFERRED_UNTIL_SYNC` classifies every frame
    tag. A read that moves nothing notifies nothing, nor does a no-op agents
    UPDATE (0106). `member_profile` carries the member's own account on
    every workspace push and on each role, name, avatar or onboarding change
    (0107), so a promoted member gets the admin UI live.
  - *Admin configuration stays a read.* The settings sections' lists
    (users, teams, MCP servers, registry items, integrations, gateway routes
    and providers, SSO) are admin editing surfaces read on open, like the
    ClickHouse analytics: the admin who edits them is the one viewing them.
    Anything a member sees change live is pushed.
  - *Engine.* The dead machine surface (`artifact.prefetch_v1`,
    `context.prepare_v1`, `MachineContext`, `edit_file`) is deleted; the CLI
    `chat` streams from the gateway itself; registry install/uninstall take
    `project_dir` per call; config-dir writes follow the read grant;
    `rpc.schema.json` declares every method and tests hold the dispatch
    table and the webview allowlist to it; one lazy, owner-only trace, off
    by default; plain-http pairing needs a loopback host or
    `GUILD_ALLOW_INSECURE_PAIRING=1`.
  - *Desktop.* `foldEvent` is the one event-to-block rule for the full and
    live paths, with keys `<seq>:<n>`. Chat rows, status, trees, projects,
    agents, gateway keys and MCP tool counts are `createStore` stores the
    socket writes; ThreadView only assembles its parts. A frame before its
    seed wins; a failed seed is an error with retry. `canonicalRoute` is the
    one address normaliser; the skills route carries the shown file and the
    catalog query; text filters replace the history entry, discrete picks
    push. A wake resyncs only a dead or stale link. Engine replies reach
    the webview as an `engine-rpc` event (no `rpc_poll`), with a per-request
    deadline set in `rpc_submit`; `rpcCall` is typed by method
    (`WebviewRpcResults`). The OIDC callback fragment is consumed in the
    route layer, and `writeAddress` in `route.ts` is the only history write.
  - *Gate.* `check.mjs` compares property shapes by name (array elements,
    inline objects, maps) and fails on undeclared types or refs; the release
    script refuses a dirty tree or a moved tag and runs it before building.
    `check.sh` gains `fmt` and `biome` (`biome ci`: the TypeScript and
    JavaScript trees are formatted and linted by `biome.json`; captured
    fixtures and JSON data are left as written) and typechecks `packages/ui`;
    the desktop targets ES2022 like the server; coherence gates
    `milestone_tags`. Tests share one disposable-database factory under
    feature names. A test that something does not happen waits on a
    barrier, never a fixed delay: `NotifyHub.barrier()`,
    `FeedForwarder.idle()` and a socket `pingBarrier()` (ping, then its
    pong) for the feed, `idle()` on the trace and usage sinks, fake timers
    for windows and backoffs.

- **A first send opens its thread once the server holds it; the keyboard
  never pans the shell (2026-11-02).** The scratch composer stays frozen
  (text, spinner) through create, uploads and submit, and the route moves
  only after the submit is accepted, onto a seeded thread already working.
  A seeded target no longer counts as navigating (no progress bar, no
  disabled composer). A pending send carries its message id and retires
  only on a state that speaks for it (generating, its echo, or a resync
  view), so a state from before the accept cannot flip the composer back to
  idle. On iOS the viewport pin undoes the keyboard pan after taking the
  visible height: the header stays and only the message list shrinks.

- **A push waits for a read, not for an absent socket (2026-11-02).** The
  notifier no longer skips a push because some member socket is open. A
  finished turn records the chat's last event seq, waits four seconds
  (`READ_GRACE_MS`), and pushes unless the owner's read marker reached it.
  Clients mark a chat read only while it is open and visible, so the read
  marker is the presence signal, per chat.

- **Layers, one home per helper (2026-11-02).** The review's structural
  findings, applied:
  - *Server layers.* The composition root is `src/composition.ts`, above
    every layer; `platform/` no longer constructs the services it hands out.
    The agent routes live in `platform/http/agents.ts`. `arch-layers.test.ts`
    checks every service folder (agents, chats, execpolicy, harness, hub,
    integrations, machines, push, sandbox, worker) and bans all of them
    from the DAL; `AgentThreadType` lives in `platform/domain`.
  - *One home.* The runtime owns the process's one `AgentStore`. Every
    transaction goes through `withTransaction`. `utcText(column)` in
    `platform/time.ts` is the one RFC 3339 timestamp expression;
    `canonicalJson` and `sortedJson` live in `platform/domain/json.ts`.
    `platform/registry-publish.ts` is the one registry publish (route,
    skills editor, `push_skill`). Common HTTP errors use the `ApiError`
    factories. The dead `Hub` interface is gone.
  - *Desktop.* `lib/store.ts` `createStore` is the store primitive; every
    store it makes, the settings cache and the agent store register with
    `lib/session-reset.ts`, and sign-out calls `resetSessionState()` once.
    The member socket's handlers read the current render's callbacks
    through a ref. The agents and skills views use the wire types. `CHAT_ROOT`
    and `SURFACE_BASE` name the root route patches. `lib/timeout.ts` is the
    one timeout race. `@guild/ui/components/empty-state` is the one empty
    state.
  - *Tests.* One `createObjectStoreStack` replaces the M6/M7 harness copies;
    `test/support/wait.ts` is the one `waitFor`.
  - *Comments* no longer narrate the Rust port or plan steps; references
    that state a live wire contract with the engine stay.

- **The engine no longer carries a turn-driving stack (2026-11-02).** Agent
  turns run in the TS server's durable harness, so the engine's own
  `agent.start` / `agent.approve` / `agent.policy.*` surface, the approval
  plumbing behind it (`agent_session.rs` with the approval policy types,
  `agent_start.rs`), the engine-side MCP client (`mcp.rs`, the `rmcp`
  dependency), the `models.list` /
  `machine.info` verbs, `daemon::spawn_detached`, the cloud calls only
  that path made, and the artifact prefetch paths had no live caller:
  neither the webview nor the CLI sent those methods. They are deleted.
  What stays is what something calls: `chat.send` (the CLI's `chat` verb,
  its stream mapping now in `chat_stream.rs`; the JoinSet that owns its
  streams is renamed `Shared.streams`), auth/session/workspace verbs,
  `machine.identify`, `registry.*`, `fs.*`, and the socket lifecycle verbs.
  `attach()` drops the binary path it ignored.

- **Second review pass: isolation, delivery and lifecycle fixes
  (2026-11-02).** A full architecture review found bugs the earlier pass
  missed; this entry records the rules the fixes set.
  - *Isolation.* An agent's conversation search and read (the tools and
    `GET /agents/:id/search`) filter by the calling user: sharing an agent
    never shares its threads. A spawn target resolves among the agents the
    requester can see (`AgentStore.findVisible`); a name two visible agents
    share picks the requester's own or answers `ambiguous_target`.
    `reconcileMachine` settles only the reconnecting machine's calls.
  - *Delivery.* A restored LISTEN connection calls each subscriber's
    reconnect hook, and the feed re-pushes every connected user's workspace,
    agent and skill state and re-captures each shown chat. The
    `guild_chat_status` NOTIFY rides the UPDATE that changes the flag, and an
    arriving turn reserves `generating` under the row lock. The SSE thread
    stream is deleted: the member socket is the only push path.
  - *Lifecycle.* A routine claim carries `claimed_at` (migration 0104); only
    a claim older than the two-minute lease with no run is reclaimed. The
    stale-run sweep skips chats holding durable work. Archiving or deleting
    an agent cancels its runs and stops their chats; restore needs an
    archived or deleting agent. An integration save writes secrets and
    config in one transaction.
  - *Trust boundaries.* The engine's remote `fs_list` refuses non-WSL UNC
    paths (`fs_bridge::check_unc_browse`, shared with the desktop browser);
    a skill bundle on another origin is fetched without the bearer. The
    user MCP SSRF guard runs on every runtime connect. The web CSP is
    `script-src 'self'`; the boot scripts load from `/boot.js`.
  - *Errors.* Every 403 names its reason (`ApiError.forbidden(message)`,
    `adminRequired()`); the phantom `owner` org role is gone. An invalid
    JSON-RPC request with an id gets an `INVALID_REQUEST` response; an
    unknown method answers `METHOD_NOT_FOUND`; engine locks are
    poison-tolerant (`sync::LockExt`).
  - *Desktop.* The agents views use the wire types (the never-sent unread
    fields are gone). The member socket redials with exponential backoff and
    full jitter (1 s to 30 s). The older-page loader and the SSO status check
    ride `lib/api/request`. Skill detail re-reads on a pushed catalog change
    and tells a 404 from an unreachable server.
  - *Tests.* The agents harness skips only on connection-level errors, so a
    failing migration fails the suite.

- **Delete closes the subtree; a deleting agent is read-only; list pushes
  coalesce (2026-11-02).** Deleting a chat cancels, closes and deletes its
  agent-thread subtree in one transaction, and the user whose run spawned a
  child chat may delete it directly (it takes its own subtree, never the
  parent). Turns and bindings to an agent in `deleting` answer 409
  `agent_deleting`; its threads stay listed read-only through the grace
  period, and restoring the agent lifts it. Agent-list and skill-catalog
  pushes send one frame per write burst (50 ms quiet window, 250 ms at
  most).

- **A view frame goes only where the chat is shown (2026-11-02).** The final
  browser pass caught a socket on /activity receiving 1.9 MB of another
  tab's compaction. Each socket records the chat its latest `sync` named;
  `thread_state`, `thread_events`, `live_frame` and `context_usage` go only
  to the owner's sockets showing that chat, while sidebar facts
  (`chat_status`, chat rows, trees) still reach every socket. A socket that
  never syncs (the engine's turn stream) keeps receiving everything. A
  changed chat republishes once per quiet 100 ms tick (300 ms at most),
  and the forced compaction republish rides the same tick, so one
  `/compact` sends at most two views. `AgentRun` carries optional
  `call_count`/`tool_count` from the trace spans. The composer names its
  agent from pushed state, and a member's address for an admin-only
  settings section is replaced by Account.

- **A push carries only what changed, and every display fact has one
  (2026-11-02).** Browser verification of the push work found a socket that
  re-sent the whole workspace bracket on every chat flip (about 90 KB per
  turn) and three facts still outside the socket. Workspace pushes are now
  a per-socket diff (`hub/sent-frames.ts`): a list that keeps its rows and
  order sends one-row `chat_row` frames to clients that connect with
  `features=chat_row`, older clients keep the full `thread_list`, and
  whole-value agent and skill frames are skipped when a user's filtered
  value did not change. Context usage is a pushed `context_usage` frame
  (`ModelOption.context_window` rides `model_list`); the meter no longer
  reads `GET /context`. A compaction task write sends `guild_compaction`
  and the feed republishes that chat's view, so a compaction that writes no
  summary, fails or is cancelled clears its line live; the `/compact`
  answer carries a `seq` so the client can tell whether a lowered state
  already covered it. A thread is named by its chat's title, and a rename
  re-pushes every header and subtree that names it (migration 0103). A chat
  the reader does not own is read-only, and `ChatTree.own` says so. An
  unknown settings, agents or skills address is replaced by the page shown.
  The run page re-reads its trace once when the pushed run finishes: the
  spans are a ClickHouse query, not socket state.

- **Agent, skill and operational state is pushed (2026-11-02).** The last
  one-shot fetches and polls for state that changes while the app is open
  are gone. Migration 0101 adds NOTIFY triggers on the agent, run, routine,
  thread, grant, team-member, chat-flag and skill tables: about thirty
  write sites move that state, and a trigger cannot be forgotten by a new
  one. `hub/agent-state.ts` turns each notify into a whole-value frame,
  scoped by the same visibility predicate the agent list uses:
  `agent_list`, `agent_run`, `agent_routines`, `agent_threads`,
  `skill_catalog`, and `chat_tree` (the child-thread header, sent inside the
  sync bracket; the client no longer fetches `GET /tree`). `model_list` is
  pushed on connect and on every gateway route write. `thread_state` carries
  `compacting`, read from the durable compaction tasks, so a compaction that
  writes no summary or fails clears its line live; the 1 s compaction poll
  is gone. `workspace_identity` names the served web bundle, which replaces
  the 60 s bundle poll: a browser tab reloads into a new bundle when idle,
  and a desktop shell never does. HTTP still seeds first paint of an
  agent's runs, threads and routines, and the windowed ClickHouse analytics
  (trace spans, Calls and Chats) stay reads with a Refresh: they are
  queries over a time window, not state. `org_event` now has a subscriber
  (the skills activity feed). The machine-presence stubs and the "Taken
  over" banner are gone: a browser socket carries no machine id, so
  `displaced` there only means the server shut down.

- **Review fixes: access, lifecycle and gates (2026-11-02).** A full review
  of the tree found authorization holes, lifecycle bugs and convention
  drift; this entry records the rules the fixes set.
  - *Chat access.* Admins may read a member's chat; every write (rename,
    archive, delete, project, approval mode, turns, appends, approval
    decisions, stop, compact, steer, attachments) is owner-only through
    `getOwnChat`, and a deleted chat refuses writes. The sync bracket checks
    access before it sends the subagent tree. An approval call settles once:
    the first decision wins under the chat row lock.
  - *Trust boundaries.* Push endpoints must be https on a known push-service
    host. `x-guild-*` trace headers count only on the internal key. An
    integration logo renders as an image, never as markup; the desktop CSP
    has no `'unsafe-inline'` script source; `rpc_submit` forwards only the
    engine methods the webview calls, and app commands are opt-in. The
    engine no longer serves `fs_read`.
  - *One shape per concern.* `/api/v1` errors are always the JSON envelope;
    only the OpenAI/Anthropic gateway keeps wire-shaped errors. The desktop
    has one REST client (`lib/api/request.ts`, one `ApiError`, one 401
    policy). Stores use one `withTransaction`; routes share one admin gate.
    `submitTurn` lives in `chats/`, the gateway pipeline in
    `platform/llm-gateway.ts`, usage SQL in `store/usage.ts`.
  - *Desktop state.* The visible thread is one store (`thread-view-store`)
    read through `useSyncExternalStore`; generating/unread live only in the
    per-chat status map, and `chat_status` moves every chat but the open one
    without retiring a pending send. A normalising route rewrite replaces
    its history entry. `HAS_SHELL`/`HAS_ENGINE` replace `IS_TAURI`. The
    Tauri shell holds no member socket of its own.
  - *Server runtime.* Project instructions persist on
    `chat_conversations.project_instructions`, so a resumed run keeps them.
    Startup attaches only chats with pending work. The feed keeps per-chat
    state only while the owner has a socket and logs every dropped push.
    Spawn checks the child limit under the parent row lock. Turns route
    through a `TurnBackend`; "supervisor" names only the reopen loop.
  - *Engine.* Each daemon host cycle opens its own link spawn feed, so a
    reclaimed host relinks. Reconnects back off exponentially with full
    jitter (1 s to 60 s). The JSON-RPC loop never awaits a handler in its
    read loop, and a lagging subscriber gets `rpc.lagged`. A turn stream
    ends only on its own terminal frame, auth loss or socket failure.
    guild-core is the local tool executor only.
  - *Gates.* `scripts/check.sh` type-checks the server, desktop and wire.
    The coherence `files`/`loc` counters are reported, not gated, and leave
    tests out. `protocol/check.mjs` holds the schemas compatible with the
    newest `client-v*` tag and checks TS scalar types.

- **A finished run reaches the phone (2026-11-01).** The socket cannot carry a
  result to a closed app, so the server now has a second transport beside it,
  not a second event system: `run_end` asks the push lane, which asks presence
  (a live member socket means the frame is enough) and then sends one Web Push
  per device with a per-thread topic, so a thread never piles up notifications.
  Devices live in `push_subscriptions` (migration 0100), keyed by a client
  device id; a 404/410 from the push service deletes the row instead of
  retrying it forever. VAPID keys are minted on first use and kept in
  `server_kv`, so a redeploy keeps the identity and existing subscriptions
  keep working. The payload names the thread and how the run ended — never the
  answer: the app syncs on open, and a push is only a hint. Settings →
  Notifications owns the per-device switch; iOS Safari reads as "add to Home
  Screen first" because that is the only place Web Push works there. The floor
  rises for the store, the sender, the notifier, the routes, the service
  worker and the settings pane.

- **The open chat's turn state is derived, not stored (2026-10-31).** `busy`
  was a `useState` with eight writers across three hooks: two of them were
  the server's own `generating` flag, four were "my send died", two were
  navigation resets, and every reader had to add `busy || openGenerating`
  back together. That is why a stale `true` could outlive a turn by 51
  minutes: nothing owned the value. Now there is one stored input —
  `pendingSend`, the chat this client sent to whose own frame has not
  arrived — and `busy = busyFrom(generating, pendingSend, openChatId)`
  (`views/thread/status.ts`). The pending send retires when the server
  speaks for that chat (`pendingAfterFrame`: a thread-state, a chat-status,
  or a failed submit). Consequences: the reconnect no longer clears a flag
  it did not set, navigation has nothing to reset, `busyAfterThreadPush` and
  the navigation machine's `clearBusy` are gone, and a swap cannot leak one
  chat's turn onto another. The floor rises by 29 LOC for the derivation and
  the sequence tests.

- **Telemetry is the workspace's decision, and the socket explains a hang
  (2026-10-31).** A user reported the app "hanging": the run finished in 15 s
  and the answer was stored, but his client kept the turn "generating" for
  51 minutes and his next message went out as a queued send. The server was
  healthy; the client missed the turn's end. Two things changed. The Faro
  switch is no longer a per-device toggle in Settings → About: it is
  `telemetry_enabled` in `org_kv`, **on when absent**, admin-only
  (`Settings → General`, `PUT /api/v1/org/telemetry`), and it rides the
  `workspace_identity` frame so every client starts or stops collecting
  live — a hang on one user's machine is only diagnosable if that machine
  reports by default. And the client now traces the sequence that explains
  such a hang: `socket.connect_start/open/close/connect_failed/watchdog_close`,
  `socket.sync_sent`, `thread.state` (applied or stale, generating, open,
  in-sync), `thread.list`, `thread.sync`, `socket.error_frame`, and every
  `busy.set` with the name of the writer that set it. The trace is bounded
  per event name and carries no message text or thread content. The floor
  rises for the switch, the frame field and the trace.

- **A thread always gets a name (2026-10-30).** The title call ran with a
  256-token cap, and a reasoning route can spend that whole budget thinking
  before it writes a word: the reply arrived empty with `finish_reason:
  length`, and the thread stayed "New thread" with no error logged. The cap
  is now 1024, and an empty or unusable reply falls back to the head of the
  user's first message, so a thread is named even when the model is not.

- **A chat message keeps its line breaks (2026-10-29).** Markdown in the
  thread, the compaction card, tool text and the agent message view now runs
  with `remark-breaks` (`CHAT_MD_PLUGINS` in `views/markdown.tsx`). CommonMark
  folds a single newline into a space, so a routine message written as plain
  `•` bullet lines arrived as one paragraph. A message is prose on a screen,
  not a document: its lines stay lines. Skill file previews keep plain GFM
  because they render a document. The floor rises by 17 LOC for the plugin
  set and its test.

- **The mobile client is an engine-less client (2026-10-28).** iOS runs no
  engine, no tools, and no machine link: it bundles its own UI and uses the
  same HTTP API and member socket as web mode. The first stage is foreground
  only — restore the session, reconnect the socket, run the normal sync
  bracket. Push comes later, and push on iOS means APNs and nothing else, so
  the server will gain a second transport beside the socket with one decision
  point, a device registry, and per-thread coalescing. Two consequences land
  before any mobile code: `IS_TAURI` must split into "the shell exists" and
  "a local engine exists", and iOS forces a TLS endpoint and a Mac build
  host. A remote UI bundle stays rejected — it moves the trust boundary and
  breaks 2.5.2/4.2. Research and the App Store rule table are in
  `docs/clients.md` §8.

- **An agent file rides its message to the client (2026-10-28).** `send_file`
  wrote the attachment row and bound it to the assistant event, but no read
  path ever used that binding: the client showed the model's "the file is
  attached" and no file. The terminal assistant message now carries the
  turn's pending agent files as `attachments` chips — the same shape a user
  message uses. The transcript projection reads the pending rows before the
  row is appended, the wire event gains the optional field (schema, Rust,
  TS), and the desktop stamps the chips onto the message's last text block.
  The event-id binding stays: it is what a child result reads to hand the
  file to its parent.

- **A sanitizer cleans keys as well as values (2026-10-28).** `jsonbText`
  and `recordJsonText` rebuilt their input with a JSON replacer, which never
  visits a key. A property name with U+0000 or a lone surrogate reached
  `jsonb` and failed the write. Both now rebuild every object through one
  cleaner, so a key and a value take the same path. `encodeValue` is
  lossless: the sandbox wire no longer replaces U+0000 in a call argument,
  because the record encoder cleans at the durable boundary. The turn
  command store compares a retry against the sanitized form, so a NUL no
  longer turns a valid retry into `command_id_conflict`.

- **A trace delta keeps the leaf's fields (2026-10-28).** A request row
  stores only the new messages. The read path now takes every non-message
  field (`tools`, `model`, the sampling settings) from the leaf, not from
  the root, so a change to them survives the rebuild. A delta longer than
  the body cap falls back to the capped full body, so a chain never holds
  cut JSON.

- **A request schema lists in `required` only what the reader needs
  (2026-10-28).** `Sync.chat_id` and `ToolResult.meta` are optional: the
  server reads an absent field as null. The fixtures still show the form
  the current writers send.

- **Older clients must keep working across core releases (2026-10-28).**
  The server and the desktop client release on different schedules, and a
  mobile client will release less often than either. A core release must
  therefore keep an installed client working. New fields are additive. A
  field or a variant is never renamed or removed without a version step. A
  reader ignores what it does not know instead of failing the frame. The
  schemas and the fixtures are the record of that promise, and
  `protocol/check.mjs` enforces it against the newest `client-v*` tag.

- **One chat row, one builder (2026-10-28).** `Chat` is now the list row and
  the body of every chat read and write: `type`, `archived` and `deleted` are
  required. The single-chat responses carried a reduced row, because they
  read one `ChatRow` and that row has no `working`, `blocked` or
  `last_activity_at`. That split cost a second shape and a hardcoded
  `unread: false`. It is gone: create, set-project, patch and delete read the
  list row back through `ChatStore.getChatListRow` and return it. The two row
  builders, `chatWire` in `platform/http/chats.ts` and `chatRow` in
  `hub/workspace.ts`, are one function in `chats/chat-wire.ts`. The desktop
  `ChatSummary` is the wire `Chat`, not an extension of it. The change only
  adds keys on the wire, so a running client keeps working; against the
  schema it is a contract change, because three properties join a closed
  object's `required` list.

- **`Json` is only for a value the protocol does not fix (2026-10-28).**
  Every frame payload that has a fixed shape now has a `$def` and a typed
  field. `thread_list.chats`, `archived_thread_list.chats`,
  `thread_state.events`, `thread_events.events`, `subagent_tree.nodes` and
  `org_event.event` carried `serde_json::Value` and a bare `Json` on the
  TypeScript side, so the contract promised nothing about them and the
  desktop cast each one. `ThreadEventRow`, `SubagentNode` and `EventRow` now
  live in `rest.schema.json` with Rust and TypeScript counterparts, and the
  socket frames reference them. The Rust frame envelope keeps `Value` for
  these rows on purpose: a daemon that does not know a new event type must
  still parse the frame it ignores. `Json` stays for tool arguments, an org
  event payload, an RPC parameter and a trigger config. The checker now
  compares every named object and union, not only the fixture roots, so
  `StreamEvent` is checked without a fixture of its own. The desktop
  `ChatSummary` no longer widens `title` to a required field: the wire omits
  it when the chat has none. The builders return the type they build:
  `threadEventObject`, `threadEventRowObject` and `projectJson` no longer
  return a bare record. The desktop's `onFrame` takes `StreamEvent`, not a
  loose frame bag; that removed a dead read, `tool_completed` has no
  `executor` field.

- **The sandbox wire is not part of the protocol contract (2026-10-28).**
  The sandbox is an implementation detail of the server: both ends ship in
  this repository, and the whole runner is a migration target. Its schema and
  its two fixtures are deleted. The frames and the value encoding stay in
  `apps/server/src/sandbox/protocol.ts`, beside the code that owns them.
  `protocol/` holds only the wires that cross a boundary we do not own: the
  member socket, the REST data-transfer types and the JSON-RPC envelope. The
  checker now registers each schema by `$id`, so a frame can reference a row
  type that another schema owns instead of copying it. `project_list`,
  `machine_list` and `tool_call_done.call` use the REST `Project`,
  `MachineInfo` and `ToolCall`. A request-only type follows the reader, not
  the writer: `CreateProjectRequest.name` may be absent, because Rust reads a
  missing `Option` as `None` while it always writes one as `null`.

- **The wire check reads the TypeScript declarations (2026-10-28).**
  `protocol/check.mjs` now parses `packages/wire/src/*.ts` with the
  TypeScript compiler and compares each fixture root against its schema:
  property names, and required versus optional. Before, it only checked that
  a declaration with the right name existed, so a renamed or weakened field
  on the TypeScript side passed. The Rust fixture round trip now compares
  the serialized JSON with the fixture frame for every root, not only the
  types without `PartialEq`; an unknown field in a fixture can no longer be
  dropped silently. Two fields the schema already declared now reach the
  wire: `approval_request.judge` (the renderer and the legacy normalizer
  dropped it) and `assistant_message.usage` (always emitted, empty when
  absent). `recordJsonText` and `jsonbText` live together in
  `platform/domain/text.ts`, so the U+0000 rule and the lone-surrogate rule
  are stated once.

- **The sandbox runner is a migration target, not the end state
  (2026-10-28).** The server-side sandbox is our own `sandbox-runner` (the
  only holder of the Docker socket) plus an in-sandbox agent
  (`agent.js`/`serve.js`/`protocol.js`). It works, but we own the daemon and
  the frame protocol. The direction is an off-the-shelf sandbox platform;
  NVIDIA OpenShell is the leading candidate. The platform supplies the
  gateway, the supervisor and the policy. We keep one server-side adapter
  from `ExecutionEnv` to the platform API. What we want from a platform:
  filesystem, process and network policy, credential brokering, and drivers
  for Kubernetes and GPU. What it does not give for free: handles, watchers,
  streamed output and cancel; the adapter must map them. The in-sandbox code
  moves from us to the vendor, it does not disappear. No change is made now:
  the current runner stays until the adapter reaches parity with
  `ExecutionEnv`.

- **The protocol branch merges with develop (2026-10-28).** `develop` brought
  the record-text sanitizer (`platform/domain/text.ts`) and the attachment
  author fix. Two merge points needed a decision. `jsonbText` now builds on
  `sanitizeText`, so one function owns the U+0000 rule and `jsonbText` owns
  only the JSON-text part. The sandbox image copies `text.js` to the path
  `sandbox/protocol.js` imports; the agent would not start without it. The
  new `text.ts` gets a `storable-text` concept in the model, and the floor is
  raised by the two files and 153 lines `develop` adds.

- **Every wire type has a schema, a fixture and a TypeScript declaration
  (2026-10-28).** The hand-written contract replaced the generator with
  `protocol/*.schema.json`, but it covered only the types that had a fixture:
  nineteen shapes the old bindings described had no schema entry — `Chat`,
  `UserInfo`, the login and pairing shapes, `MachineInfo`, the chat and
  project request bodies, `ChatCompletionRequest`, `MachineContext`, and the
  JSON-RPC envelope. Those rows were `Record<string, unknown>` on the server
  and private copies on the client (`ChatSummary`, `UserInfo`), so nothing
  checked them against Rust. All nineteen are now schema definitions with
  fixtures: `rest.schema.json` for the HTTP DTOs, `socket.schema.json` for
  `MachineContext`, and a new `rpc.schema.json` for the stdio envelope. The
  Rust suite round-trips each fixture back to the same JSON (a second helper
  for the types without `PartialEq`), and `check.mjs` now fails when a
  fixture root has no `@guild/wire` declaration. Two Rust structs had drifted
  from what the server sends: `Chat` lacked `working`, `blocked` and
  `last_activity_at`, and `UserInfo` lacked `onboarded`. Both now carry them,
  and `chatRow`, `machineInfo` and `userInfo` return the shared types. The
  client's private `UserInfo` and its duplicate `ChatSummary` fields are
  gone: `ChatSummary` extends `Chat`. The coherence floor rose by 2 files and
  394 loc; the duplicated declarations paid about 20 lines of it, and the
  rest is the contract itself.
- **Records are JSON text; queries parse them in code (2026-10-28).** A
  `codemode` tool result carried an `.xlsx` dumped as text, so the record
  contained a `\u0000` escape. `ThreadStore.contextUsage` cast
  `entries.record::jsonb`, and JSONB rejects U+0000: the context meter
  answered 500 with `22P05` on that thread. The storage contract already
  says record columns are text, not JSONB. The fields queries filter on are
  now real columns — `entries.kind` and `tasks.outcome_status` — written
  from the same record in the same statement. The read paths parse the one
  row in code. U+0000 cannot enter a record: the sandbox wire and the
  durable encoder replace it with U+FFFD. A source test keeps
  `record::jsonb` out of the server.

- **A user upload records its author and stays pending (2026-10-28).**
  Migration `0088` set `attachments.event_id`, `author_kind` and
  `author_id` to `NOT NULL` once the backfill left no gaps. The user upload
  path inserts none of the three, so every upload answered 500 with
  `23502` on any database that reached that state (prod did; dev did not,
  because its table was empty at migration time). Only an agent file gets an
  `event_id`, bound when the turn's assistant event lands. A user upload is
  pending until a message references it. Migration `0099` drops `NOT NULL`
  on `event_id` again, backfills old authors from the chat owner, and keeps
  `author_kind`/`author_id` required; `AttachmentStore.create` writes
  `author_kind='user'` and the uploader's id.

- **The prompt names the Guild user of the thread (2026-10-28).** A routine
  reported "no new Jira tasks" while five were assigned to the user. The
  prompt carried no identity: the model learned who it talks to from
  whatever a tool answered, and Jira's `currentUser()` answers for the API
  token's account — here another person's. The guild prompt section now
  appends one line built from the chat owner:
  `<current_user name="…" email="…" />`. `ChatStore.ownerOf` joins `users`
  and returns the owner's account fields (email, display name, role); the
  skills runtime deps read the role from it instead of a second query.
  Identity reaches the prompt only — usage and trace rows keep their
  `user_id`.
- **The wire is a schema and fixtures, not a generator (2026-10-28).** The
  TypeScript frame types came from `ts-rs`: `cargo test -p protocol --features
  ts` wrote 72 `.ts` files into `crates/protocol/bindings`, a perl pass
  rewrote their imports, an in-place `tsc` emitted `.js`/`.d.ts`, and
  `scripts/check-bindings.sh` failed on drift. Fourteen import sites used it,
  all `import type` — no runtime value ever crossed. The pipeline is gone.
  The contract now lives in `protocol/`: `socket.schema.json` for the member
  socket and `rest.schema.json` for the HTTP DTOs, each derived field by field
  from `crates/protocol/src/`. The types are hand-written on both sides —
  `packages/wire` (`@guild/wire`) for TypeScript, the Rust crates as before —
  and `protocol/fixtures/<schema>.<Root>.json` holds one example per variant.
  `protocol/check.mjs` validates every fixture against its schema and requires
  a fixture for every variant; `crates/protocol/tests/fixtures.rs`
  deserializes every one of them, so a schema that drifts from Rust fails the
  Rust suite. No Rust generates TypeScript in any form.
  - **Presence, not bytes.** The old golden test compared raw strings, so the
    server hand-assembled JSON to reproduce serde's key order and float text.
    The contract is presence: the same field is present or absent, and `null`
    means null. Key order and number text are not load-bearing, so the
    serializers are plain objects and `JSON.stringify`. The golden test parses
    both sides and compares normalized values. This removed about 290 lines.
  - **The cost.** `packages/wire` is 4 files where the generated tree was 72,
    and the coherence counters moved by +4 files and +24 loc, because the
    scanner already skipped generated files. Net against `develop` is down
    5 loc, and the +24 is the fixture test that makes the TypeScript side of
    the contract real.
  - **The same idea elsewhere.** `rustJsonText` re-implemented serde_json for
    HTTP responses — sorted keys, ryu floats, a marker that kept a `.0` tail.
    It served 61 call sites in 17 files and it is gone; those responses are
    `JSON.stringify` too. The sandbox `ClientFrame`/`AgentFrame` are
    `SandboxClientFrame`/`SandboxAgentFrame` so the name is not shared with
    the member socket.

Older decisions (before 2026-10-28): `docs/archive/decisions.md`.

## Future directions

- **Decide the skill scope: per-user installs or per-agent sets (open,
  2026-10-21).** Installs and pins are per user today, and a chat resolves
  them through its owner (`identity` in `apps/server/src/harness/skills.ts`),
  so two people who use the same shared org agent get two different skill
  sets and two different pins from it. The alternative mirrors the existing
  tool pattern: `agents.skills` (JSONB slug list) plus `agents.skills_mode`
  (`selected` | `all`), with personal agents defaulting to `all`. That
  costs a migration, the four call sites in `harness/skills.ts`, the agent
  create/update routes, the agent settings UI, and a new source for the
  machine-sync payload (the union of the skill sets of the agents a user
  can run). Kept per-user for now: pins are optional and installs follow
  the latest, so the wrong-scope damage is small. Revisit when a shared
  agent needs a fixed skill set for everyone.

- **Schema-first protocol types (protobuf or similar)** (2026-10-14):
  define the wire types once in a language-neutral IDL and generate both the
  Rust and TS types from it, instead of hand-writing them on each side.
  Removes the hand-written copies on each side. Precondition for picking the tool: it
  must preserve the fixture conformance gate and the 64-bit wire-field
  number handling.

- **Wire field renames (`chat_id` → `thread_id`) are still open.** The
  routes and client paths moved to threads in 0.5.47; the wire fields did
  not. Any rename is a client/server coupling decision, so it ships as one
  deliberate release.

- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `2026-09-24-loop-summary.md` (git history) for the per-surface pass counts
  and the process playbook (mixed reviewers; pi fixer/verifier; verifier
  rebuilds exploit chains against the real caller; env var gotcha:
  `GUILD_TEST_PG_URL` is a base URL without a db suffix).

- **Engine/product direction unchanged:** one agent loop, thin desktop
  backend, project-derived executor binding, durable turns on `pi-durable`. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.
