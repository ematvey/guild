# Guild — Product Requirements Document (PRD)

## 1. What Guild is

Guild is a self-hosted replacement for commercial AI coding and coworking
services at the organization level. An organization runs its own Guild server
and owns its data and its model resources: chat history, skills, integration
credentials, provider keys, usage records, and cost control all live on the
org server instead of with a vendor.

Members chat with models through the org gateway. Agents run tools where the
work lives: on a member's machine through the paired desktop app, or in a
server-side sandbox for chats with no workspace. Long-running work is durable:
a run survives a crash or restart and resumes from its recorded steps.

Product surfaces:

- **Desktop app** — per-machine GUI plus the machine's tool executor. One
  Rust backend process hosts execution, the file bridge, and the CLI verbs;
  the webview is a pure interface that owns context assembly.
- **Web UI** — served by the org server; a browser tab is a full chat client
  and carries the admin surfaces.
- **Headless CLI / engine callers** — scripts and tools that drive the local
  backend process over the engine protocol.

## 2. Actors

- **Org admin** — configures the org: provider keys, model routes and quotas,
  integrations and their tools, registry review, users and teams, approval
  defaults, releases, usage and audit surfaces.
- **Org member** — chats, binds chats to projects, installs skills and
  registry items, creates routines, answers approvals.
- **Desktop user** — a member on a paired machine. The desktop app is both a
  chat GUI and the machine's executor; pairing and the machine identity are
  managed there.
- **CLI / engine caller** — a script or tool that drives the local backend
  process (login, chat, publish, install) without the GUI.
- **External callers** — webhook senders and script-API clients that hit org
  endpoints with org credentials.

## 3. Product requirements

Identifiers are stable (`PRD-n`) for citation. Each requirement is one
sentence followed by acceptance criteria.

### 3.1 Chat

**PRD-1 — Org-gateway chat.**
Members chat with models only through the org gateway, and provider
credentials never leave the server.

- A chat streams token-by-token in every client.
- Model availability follows the org's model routing configuration.
- Every model request records usage (org, user, team, model, tokens, cost).
- No client ever receives a provider key.

**PRD-2 — One live thread state.**
Every device viewing a chat renders the same authoritative content.

- A committed message appears on all the sender's devices, including the
  sender's own view (server echo settles the optimistic pending marker).
- A reconnecting client rebuilds its view from the server's state, never
  from local merge logic.
- A generation's progress (text, tool calls, approvals) is visible while it
  runs, from any device.

**PRD-3 — Durable runs.**
An in-flight run survives a server restart and resumes from its recorded
steps.

- A tool call waiting on a machine resumes when the machine returns the
  result, or fails with an explicit message when the machine stays gone.
- A replayed run repeats no side effect and duplicates no result.
- A user can stop a run at any point; the turn ends cleanly at the next step.

**PRD-4 — History.**
The thread log is the durable record of every chat, readable from any device.

- Sends, tool calls, results, and approvals are all in the log.
- Oversized tool results are stored as artifacts, not as verbatim history
  bulk (see PRD-22).
- Archived chats drop out of the thread list but stay reachable by direct
  link.

### 3.2 Projects and binding

**PRD-5 — A project is a named folder on a machine.**
A project names one folder on one machine; that folder is the tools'
workspace for any chat bound to the project.

- A project's folder may be a plain OS folder or a WSL distro folder; tools
  run inside the distro when the folder is a distro path.
- The sidebar groups chats by project; projectless chats appear in a Recents
  view.
- Any project member device renders the project's machine and folder
  identity.

**PRD-6 — Two chat states only.**
A chat is either project-bound or fully unbound; no third state exists.

- A project-bound chat's executor machine comes from the project; the chat
  cannot name a machine directly.
- Unbinding (or deleting) a project clears the chat's machine binding.
- A machine-bound chat always has a project behind it; the machine pill and
  offline banner appear only on project-bound chats.

**PRD-7 — The desktop with no project is a GUI for unbound chats.**
A chat sent from a desktop app with no project bound is fully unbound.

- Its tool calls run in the server-side sandbox, like any web chat.
- It is never auto-dispatched to the sending machine.
- It shows no machine affordance.

### 3.3 Machines

**PRD-8 — Pairing and singleton liveness.**
The server issues each machine's identity at pairing, and exactly one live
connection per machine exists at any time.

- A live slot is held, not displaced: a second instance's connect is
  rejected and the holder keeps the machine. A reconnect of the same
  instance replaces its own zombie slot.
- Machine liveness equals its live connection; there is no separate
  heartbeat notion for the user.
- A machine's identity persists across app restarts; the link runs in the
  app process, or in the `Guild daemon` user unit on a headless host.

**PRD-9 — Re-pair adoption.**
Pairing again on a machine the org already knows takes over the existing
machine identity.

- A hardware-fingerprint match within the org adopts the existing row, so
  existing project bindings keep working; the previous registration is
  displaced.
- A fingerprint mismatch creates a new machine.
- The fingerprint is an adoption hint only — a live registration is never
  re-keyed because its fingerprint changed.

**PRD-10 — Machines page.**
Users see every machine registered to them, not only the live ones.

- Connected machines show a live indicator; offline machines show when last
  seen.
- An offline machine stays listed after the app exits.
- Each row shows OS, app version, and pairing metadata.

### 3.4 Approvals and exec policy

**PRD-11 — Approvals.**
Tool actions that need consent ask the user, on any device, and the run
waits for the answer.

- The account-level policy has three modes: ask, approve-for-me, and full
  access; a chat can override it.
- An approval decision from any of the user's devices settles the pending
  call.
- A stop while an approval is pending counts as a denial.
- An approval that waits too long is auto-denied with a visible reason.

**PRD-12 — Exec policy.**
Shell commands pass through static rules before any interactive gate.

- Rules classify a command as allowed (runs silently), forbidden (hard deny
  with the rule's justification), or prompt (falls through to the approval
  gate).
- Unmatched commands fall through to the approval gate.
- The admin can edit the policy guidance used for automatic approval
  decisions.

### 3.5 Skills and context assembly

**PRD-13 — Skill bundles.**
Members author, publish, install, and disable SKILL.md skill bundles.

- Installing targets the repo scope by default or the user-global scope.
- Every registry-installed or published skill carries a provenance sidecar;
  uninstall refuses directories Guild did not install.
- A per-skill disable toggle removes a skill from discovery without
  deleting it.

**PRD-14 — Skill index and `/name` invocation.**
The agent sees a bounded index of available skills, and the composer can
invoke a skill explicitly.

- The index lists each skill's name and description, within a fixed char
  budget, with an omission notice when over budget.
- Typing `/` at word start opens the skill autocomplete.
- A `/name` mention injects the full SKILL.md body as context for that turn.

**PRD-15 — Agent instructions.**
An agent thread's instructions come from the agent workspace, and a local
engine chat still gets the project's AGENTS.md chain.

- Agent threads read `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `USER.md`,
  `MEMORY.md` and `BOOTSTRAP.md` from the agent workspace on every turn,
  under a per-file and total byte budget.
- Editing a workspace file changes the next turn; no restart or re-pair is
  needed.
- A workspace file over its cap is truncated, and the agent sees the
  truncated text.

### 3.6 Integrations

**PRD-16 — Org-wide connectors.**
An admin connects an integration once; every member's agent gets its tools.

- Supported connector kinds include built-in vendor connectors and MCP
  servers; both expose their tools the same way to the agent.
- Credentials are stored encrypted on the server, rendered masked, and never
  returned by any API.
- A save is verified with a live connection test before it persists.

**PRD-17 — Per-tool curation.**
The admin sees every tool an integration declares and controls each tool's
exposure and approval.

- Each tool has an enabled flag and an approval setting.
- A tool the admin has not enabled is invisible to the model and to scripts.
- An admin can force an approval prompt on every call of a tool, overriding
  the user's own policy.
- Newly appearing tools of a live MCP server land disabled.

**PRD-18 — Tool script API.**
Scripts call the same integration tools over HTTPS that the chat loop calls.

- Authentication is a member session or an org API key.
- The script API applies the same policy filtering and curation as chat.
- Every call is audited.

**PRD-19 — Identity and impersonation.**
Every integration call carries an acting identity resolved from the caller.

- The acting identity joins on the member's email by default.
- Only an admin may act as another member's identity.
- Every call appends an audit event recording caller, acting identity, tool,
  and outcome.

### 3.7 Registry

**PRD-20 — Publish, review, install.**
Members publish registry bundles; admins review; installs pull approved
content only.

- Publishing works from the desktop and the CLI.
- Review approval binds to an exact version and bundle hash; later content
  changes un-approve the item until re-reviewed.
- Installing an unapproved item is refused.

**PRD-21 — Client releases.**
The org distributes signed desktop releases through its server.

- Release artifacts are signed; the public key is available for clients to
  verify downloads.
- An update feed serves the latest release; clients update themselves.

### 3.8 Tool artifacts

**PRD-22 — Download cards.**
An oversized tool result becomes a first-class artifact the user can
download.

- The chat shows a download card with filename, size, and type.
- The model receives short pointer text naming the materialized path; text
  results keep a short head excerpt inline.

**PRD-23 — Materialized workspace files.**
An artifact materializes as a real file inside the workspace.

- The model reads it with the ordinary file tools, no special knowledge.
- The file is fetched lazily on first touch and prefetched opportunistically
  while the machine is connected.
- Materialized copies persist.

### 3.9 Routines and triggers

**PRD-24 — Routines.**
Users create durable routines — a trigger plus an agent configuration — that
run on the server without a chat open.

- Trigger kinds are cron schedules and one-off runs at a set time.
- Routine runs are journaled and resumable; run history is visible.
- A routine that exhausts its step budget ends with a visible explanation.

### 3.10 Web UI and admin surfaces

**PRD-25 — Web chat.**
A browser tab is a full chat client.

- Web chats support projects, approvals, tools, attachments, and artifacts.
- A project-bound web chat dispatches tools to the project's machine, and
  the workspace instructions are fetched machine-mediated.
- A web chat with no project runs tools in the server sandbox.

**PRD-26 — Admin surfaces.**
Admins manage the org from the web UI Settings sections.

- Users, teams, provider keys and routes, integrations and their tools,
  registry review, org approval defaults, and prompts are all manageable.
- Desktop releases are not managed here; they are published from the dev
  checkout.
- The console shows org events (including integration audit) and usage
  surfaces.

### 3.11 Usage and cost

**PRD-27 — Usage and cost dashboards.**
Admins see cost and token usage per user, team, model, and day.

- Cost is computed per request from token counts and org-configured prices.
- Dashboards answer roll-ups directly from usage records.
- Members see their own usage.

**PRD-28 — Quotas.**
Admins cap monthly spend per model.

- A turn that would exceed the quota is rejected with an explicit
  over-quota error before any model call.
- Quota state reflects recorded usage.
