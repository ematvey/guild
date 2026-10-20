# OpenClaw — IA notes for Guild

OpenClaw's Control UI was rebuilt (v2026.8.1) around one rule: the conversation
is the centre; everything else is a property of it or of the agent that owns it.
The old Overview page was retired.

## 1. Entity model

```
Gateway
├── Agents — identity, avatar, model, workspace dir, instruction files
│   (AGENTS.md, SOUL.md, USER.md, MEMORY.md), tools, skills, channels
│   ├── Main session "agent:<id>:main" → rendered as Home, not a chat row
│   ├── Sessions — title, icon, colour, owner, custom group, project +
│   │              branch, parent/child nesting, snooze, archive
│   ├── Automations — schedule, payload, execution style, delivery, run history
│   └── Memory — plain Markdown files in the workspace + search index
├── Projects — registered git checkouts / agent workspaces
├── Runs — per automation run: execution status, completion status, transcript
└── Inbox — approvals, questions, failed runs, updates (per-agent scope)
```

- Agent owns sessions; sessions are listed per agent by default, with a
  "Show all agents" team mode that groups them under agent headers.
- Session owns workspace: path, project, worktree, branch, PR links. Projects
  are a *property of a session*, not a container page.
- Automation belongs to an agent and names an execution session (`isolated`,
  `current`, `session:<key>`) separately from its *delivery* target.
- Run belongs to an automation and references the automation, the session, and
  a transcript generation. Memory is per-agent files on disk, not a UI entity.

## 2. Navigation

Icon rail, then list pane, then work area. Rail: agent avatar (agent menu),
accented **+ New conversation**, three view buttons (**Pages / Sessions /
Users**), command-palette search, fixed footer **Home · Inbox · account**.
Pins of pages, sessions, people sit in the rail.

- **Pages** = resource catalogue: Agents, Sessions, Automations, Dashboards,
  Usage, Plugins, Settings. Pinning adds a rail shortcut, not a second list.
- **Sessions** = conversation list, zoned Other / Groups / Coding, plus custom
  groups. `Group by`: Custom groups | Project | Person | None. Status: Active /
  Snoozed / Archived / All.
- **Home** = the agent's main session, in the footer, never a row. It also opens
  as a dock beside any page.
- **Inbox** = alert hub, scoped to the selected agent.

Routes: `/agents` (roster of agent cards: identity, model, status, last
activity, main-chat preview), `/sessions` (table + **Worktrees** tab), `/new`
(draft page — nothing is created until the first message), `/settings/agents`
(per-agent tabs: Overview, Files, Tools, Skills, Channels, Automations, Memory).

Session page = transcript + header (project identity first, session menu) +
optional dock (Details, Files, Browser, Terminal). Chat and a per-thread
Dashboard are two views of one session; each thread remembers which.
Settings holds per-agent config; work lives in Pages.

## 3. Activity / run history

Three layers, no global feed:

1. **Live state on the row**: activity ring (spins; pauses as "Queued" during
   scheduler waits), unread dot, unsent-draft pencil, failed-run warning, and an
   attention icon whose tooltip shows the oldest pending question or approval.
2. **Automations page**: stat cards (count, failing, scheduler state, next wake)
   over two tabs — **Automations** (filterable table: All/Active/Paused, search,
   schedule and last-run filters) and **Run history** (recent runs across all
   jobs).
3. **Per-automation page**: Active/Paused + Run now in the header; tabs are
   **Settings** and **Run history** (that job only). A row shows execution
   `status` (ok/error/skipped) and whole-run `completionStatus` (succeeded/
   failed/unknown), rendered `OK · Error` when execution worked but delivery
   failed. **View transcript** opens that run's conversation; notification links
   deep-link to the exact run ID.

Silent runs are first-class: `delivery: none`, intentional `NO_REPLY`, and
heartbeat acks record a run with `deliverySuppressionReason` — no claimed
delivery, no alert. Empty model output is *not* silence; it records a failure.

## 4. Naming

- **Sessions**: model-generated, not first-message truncation. After a 1 s typing
  pause the agent's *utility model* names the session from the first 1,000 chars
  (off for slash commands/incognito). Start never waits. Language of the first
  message, 60-char cap. Fallback is a two-word crustacean-themed name. Later
  messages never regenerate a title. Manual rename wins; clearing it restores
  the generated title.
- **Agents**: user-set name, emoji, image; generated face is stable per agent ID.
  Chip tooltip carries `agent:<id>` so duplicate names stay distinguishable.
- **Automations**: user names the job; templates prefill name, prompt, schedule.
  Runs are unnamed — job name plus exact timestamp/ID.
- **Groups/pins**: group names, order, defaults in the Gateway (follow the user);
  collapsed state and pins in the browser profile.

## 5. Three patterns Guild could borrow

**a) Agent as rail root; default thread is "Home", not a chat row.** Switcher at
the top, list scoped to the agent, Home in the footer and as a dock.
*Trade-off:* one agent dominates the rail; needs an all-agents mode. *Payoff:*
"where does this agent live" is one click, and the default thread never competes
with real work.

**b) Runs are a tab under the thing that produced them, with a rollup one level
up.** Job table → per-job Settings + Run history → cross-job Run history; runs
deep-link by ID. *Trade-off:* no single feed, so silent runs are visible only in
Automations; failures must be duplicated into an alert surface. *Payoff:*
history stays attached to its owner instead of becoming a firehose.

**c) Projects as a property of a thread, not a sidebar folder.** Registered
checkouts; New-session **Place** picker; project identity first in the chat
header; `Group by: Project` is just a sort. *Trade-off:* no rich project page
(no project instructions or members; context lives in workspace files).
*Payoff:* no duplicate hierarchy — a thread is never "in" a project and also
"in" an agent.

## 6. Recommendation for Guild

1. **One owning hierarchy, one browsing axis.** Agent owns threads, workspace
   files, routines, runs. Project is an attribute (workspace path + optional
   instructions) carried by threads and routines. Chats become threads; a
   standalone chat is a thread of a default agent.
2. **Rail**: Agents · Chats · Routines · Activity · Skills · Settings. Agent
   page tabs: Threads · Routines · Files · Activity · Settings. Default thread
   opens from the agent header, not from Chats. Add "Show all agents" grouping
   and a project filter chip instead of a Projects node.
3. **Routines**: job table + stat cards; per-routine Settings and Run history
   tabs; rows show execution status *and* delivery outcome; silent runs recorded
   with a reason; every run opens its transcript. Delivery: open new thread |
   append to thread | silent.
4. **Activity**: one page, three scopes (agent / routine / all), filterable by
   status, each row linking to the run's thread. Failures also raise an alert,
   so a silently failing routine cannot hide.
5. **Search**: server-side over thread titles and message text, scoped by the
   current agent filter, in the command palette with title and message groups.
6. **Naming**: utility-model titles, 60-char cap, manual rename wins; user names
   routines; runs identified by routine + timestamp.

## 7. Sources

- https://docs.openclaw.ai/llms.txt
- https://docs.openclaw.ai/web/control-ui
- https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar
- https://docs.openclaw.ai/web/control-ui/feature-reference
- https://docs.openclaw.ai/releases/2026.8.1/the-new-web-ui
- https://docs.openclaw.ai/concepts/main-session
- https://docs.openclaw.ai/concepts/session-search
- https://docs.openclaw.ai/concepts/agent-workspace
- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/automation/cron-jobs/how-it-works
- https://docs.openclaw.ai/automation/cron-jobs/managing-jobs
- https://docs.openclaw.ai/automation/cron-jobs/delivery
- https://docs.openclaw.ai/gateway/audit
