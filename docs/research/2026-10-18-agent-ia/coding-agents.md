# Coding-agent products: tasks, chats, projects, activity

## 1. Comparison

| Product | Top-level object | Sessions / tasks | Activity location | Naming |
|---|---|---|---|---|
| **OpenAI Codex** | Project/workspace (local folder) or cloud **environment** (repos + tools) | A **task** is a conversation with its own workspace, started from a published environment. Each task keeps its own files and VM state. | Task detail: transcript, changed files, diff, test results, logs, PR. Sidebar groups tasks by project, with pinned and archived groups. An Activity view shows generated last-turn summaries. | Auto title from the first prompt. Rename, pin, archive. Rename is still rough in some clients. |
| **Claude Code** | Local **project directory**; cloud **Project** is a coordinator container | Local: **session** = saved conversation tied to a directory. Cloud Project: one coordinator conversation plus child **threads**, each a full session. Background sessions are sessions too. | `claude agents` (agent view): sessions grouped by state (Needs input, Working, Ready for review, Completed), with a generated one-line summary and PR badge. Project **Overview** groups threads by state. The transcript holds detail. | Manual `/rename` or `-n`; otherwise a Haiku-generated title from the first prompt or accepted plan. Sessions are resumable by name. |
| **Cursor** | **Agent run** in a repo or multi-repo environment | A run is a conversation plus an isolated VM, branch, and PR. Runs can subscribe to PR, CI, Slack, or Linear events and wake in the same conversation. | Agents dashboard lists runs with filters (source, status, date, code changes, PR, archived). Run page shows events, transcript, diff, setup logs, and artifacts (screenshots, video, logs). | Auto title; `rename-chat` tool and header rename. Team-visible by default. |
| **Devin** | **Session** = task, inside an organization and repo set | Sessions are the unit of work. Ask mode plans; Agent mode executes. | Session timeline (steps, shell, IDE, browser) plus post-hoc Session Insights. Automations have an **Activity** tab: invocations, skipped runs, links to sessions, sparkline. | Auto from prompt; tags for filtering. Playbooks and Knowledge/Skills are separate reusable objects. |
| **GitHub Copilot** | **Repository** | A **session** is one agent run, started from the agents panel, an issue, a PR, or chat. | Agents panel and agents page: session list, log, overview, token usage, duration. Commit messages link to the session log. Automations live under the repo **Agents** tab. | Auto from prompt or issue. Archive. Natural-language search over past sessions. |

## 2. Three recurring IA patterns

**A. Flat task feed (Codex, Devin, Cursor).** The run is the top-level object; repos and environments are labels. Activity is the task list plus each transcript.  
Trade-off: fast for many one-off tasks. It gets noisy at scale and has no persistent identity.

**B. State dashboard over sessions (Claude agent view, Copilot agents panel).** Sessions group by what they need: needs input, working, ready, completed. Generated summaries make the list readable without opening transcripts.  
Trade-off: excellent triage. Sessions stay ephemeral, and the dashboard becomes a second inbox.

**C. Container with child runs (Claude Projects, Codex environments, Devin automations).** A durable container holds instructions, memory, repos, and credentials, then spawns threads or runs that report back.  
Trade-off: strong shared context. It adds routing, and containers can duplicate task lists.

## 3. What to copy

- **Codex:** one detail view that unifies transcript, diff, files, logs, and PR. Reusable environment; isolated per-task workspace. Generated summaries in the list.
- **Claude Code:** state grouping, one-line summaries, PR badges, and filters by agent/state/name/outcome. Shared project instructions and memory. Scheduled tasks become ordinary sessions.
- **Cursor:** artifacts (screenshots, video, logs) attached to the run and PR. Event subscriptions that wake the same conversation.
- **Devin:** automation Activity tab with skipped runs, limits, session links, and a sparkline. Versioned playbooks.
- **Copilot:** commit-to-session-log links. Natural-language search over past sessions. Archive, not delete.

## 4. Recommendation for Guild

**Make the chat/thread the only run atom.** Every interactive turn and every cron run creates a chat. Do not add a user-visible "run" or "task" object. This keeps search and transcripts in one place.

**Agent = configuration + workspace + a home for threads.** An agent is not a chat and not a folder. Its page has tabs: **Threads**, **Routines**, **Files**, **Activity**, **Settings**. The default thread is pinned as "Main"; extra threads are normal chats owned by the agent. Sidebar: **Agents** rows expand to threads; a separate **Chats** section holds unowned chats. One owner only. Do not nest project > agent > thread > run.

**Project = optional grouping.** Let a project collect chats and agents by outcome or repo. If both can own a thread, pick one owner and tag the other.

**Activity = actionable cross-agent inbox.** Replace a dead audit table with **Runs**, grouped as **Needs you**, **Running**, **Failed**, **Done**. Each row shows agent, source (manual/cron), generated summary, time, and links to thread and artifacts. Filter by agent, project, status, source. Silent cron runs appear here but do not create an unread chat. A cron run opens a thread only when it has something to say. Silence stays visible without noise.

**Naming and search.** Auto-title from the first prompt or run result; allow rename everywhere. Cron threads use "Routine name · date"; keep "Main" stable. Search chats, threads, and summaries with scope chips for agent, project, and date.

## 5. Sources

- Codex Cloud: https://learn.chatgpt.com/docs/cloud
- Codex environments: https://learn.chatgpt.com/docs/environments/cloud-environments
- Codex app: https://learn.chatgpt.com/codex/app
- Claude Code sessions: https://code.claude.com/docs/en/sessions
- Claude agent view: https://code.claude.com/docs/en/agent-view
- Claude Projects: https://code.claude.com/docs/en/claude-projects
- Claude scheduled tasks: https://code.claude.com/docs/en/routines
- Cursor Cloud Agents: https://cursor.com/docs/cloud-agent
- Cursor events/artifacts: https://cursor.com/docs/cloud-agent/capabilities
- Devin first session: https://docs.devin.ai/get-started/first-run
- Devin playbooks: https://docs.devin.ai/product-guides/creating-playbooks
- Devin automations: https://docs.devin.ai/product-guides/automations
- Devin session insights: https://docs.devin.ai/product-guides/session-insights
- Copilot on GitHub: https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github
- Copilot sessions: https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
