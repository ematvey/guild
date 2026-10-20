# Consumer assistants: agents, projects, chats, tasks

How ChatGPT, Claude, Gemini, Perplexity and Copilot split or merge these objects.
Checked against vendor docs, October 2026.

## 1. Comparison

| Product | Agents | Projects | Chats | Scheduled tasks | Naming |
|---|---|---|---|---|---|
| **ChatGPT** | GPTs: saved prompt + tools + knowledge, sidebar section and store. A chat with a GPT cannot be moved into a Project. | Container for chats, files, instructions, memory. Files also live in a separate Library. | Auto-titled from the first message; user renames. Pinnable, archivable, searchable. | **Scheduled** page: one inbox. A standalone task opens a new chat per run; a task can also bind to an existing chat. Tasks cannot use GPTs or project files. | Model title, user override. Task title separate from chat title. |
| **Claude** | No agent entity in chat; skills modify the one Claude. Code Projects add a coordinator per project. | Files + instructions + memory, usable from any conversation. Code Projects beta: one conversation that spawns threads. | One list, **Recents**, holds quick chats and long tasks. Chat and Cowork merged. | Global **Scheduled** page plus a tab inside each Code Project. Each run is its own session. | Model title, user rename; thread titles model-generated. |
| **Gemini** | Gems: saved instructions + knowledge. A Gem chat sits in normal history. Gems become "skills" in Nov 2026. | None. | Normal history. A schedule is bound to a chat, so its output lands as an unread chat. | **Scheduled** page. Each schedule points at a chat. Max 10; content prepared before delivery. | Model title, user rename. |
| **Perplexity** | No separate agent; one agent ("Computer") runs inside Projects. | Renamed from Spaces. Shared file system, instructions, connectors, skills, Brain (memory), sessions, Slack bindings. | Sessions. A session can be converted into a project. | Not first-class; asked for inside a session. | Suggested from the session; user edits. |
| **MS Copilot** | First-class: declarative or custom engine. Agent store, admin lifecycle, @mention in Teams. Only custom engine agents act proactively. | No project object. Notebooks hold reference material for a bounded task. | Chats in Copilot, Teams, Outlook. | Copilot Studio flows; no user-facing scheduled list. | Auto title. |

## 2. IA patterns and trade-offs

**A. Agent-centric** (ChatGPT GPTs, Copilot). The agent is a sidebar destination;
chats attach to it. Clear answer to "who is working". Cost: two objects both claim
to be containers, and a chat cannot belong to both. ChatGPT resolves this by
forbidding the move, which creates the seam users hit first.

**B. Project-centric** (Perplexity, classic Claude Projects). One container holds
files, instructions, memory and threads. No duplicate containers. Cost: cannot
express "this agent runs the weekly report across three projects"; the agent
collapses into the product.

**C. Thread-centric, agent as modifier** (Gemini Gems, unified Claude Recents).
One conversation list; the agent is chosen at start or not at all. Cheapest to
learn. Cost: no per-agent workspace, and background work is hard to find.

**D. Coordinator + threads** (Claude Code Projects beta). A project is one
coordinating conversation that spawns threads; an Overview pane shows thread state
(Ready for review / Waiting on you / Working / Landing / Idle / Resolved), with
Library, Pull requests and Scheduled tabs. Activity is thread state, not a page.
Closest existing model to Guild's agent, and the most expensive to build.

## 3. What feels confusing, and why

- **ChatGPT**: three overlapping containers. A GPT chat cannot enter a project. A
  task cannot use a GPT or project files. Deleting a chat silently pauses its
  task. Users learn which pairings are legal instead of which object they want.
- **ChatGPT tasks**: output is sometimes a chat, sometimes a row in Scheduled, so
  "where did my report go" has no single answer.
- **Claude**: two things are called Projects (chat Projects and Code Projects
  beta). Scheduled tasks appear both globally and inside a project. Recents mixes
  a one-line question with a two-hour task.
- **Gemini**: a Gem is both saved configuration and a history entry. A schedule
  is bound to a chat, so scheduled output competes with human chats for unread
  badges. Demoting Gems to "skills" shows the agent object did not carry weight.
- **Perplexity**: the Spaces-to-Projects rename erased the line between a saved
  search set and a workspace with a file system.
- **Copilot**: agents live in app chrome, so no single place shows what an agent
  did. Activity is an admin concern, not a user view.

## 4. Recommendation for Guild

Agent as a top-level object, thread as the only unit of conversation, activity as
a view rather than a container.

1. **Two axes, not two containers.** Agent answers "who works"; project answers
   "what is this about". A thread has one agent and zero or one project, not the
   exclusive membership ChatGPT forces.
2. **Agent page = one object with tabs**: default thread pinned on top, then
   Threads, Routines, Activity, Files, Settings. Agent threads also appear in the
   global Chats list, filtered. One thread, two views, never a copy.
3. **Routines live under the agent; every run is an activity row.** A run with
   something to say opens a new thread and so appears in Chats. A silent run
   appears only in Activity, with a dot on the agent. One record per run, one
   optional thread. This fixes ChatGPT's split artifact.
4. **Global Activity page**: reverse-chronological run log across agents,
   filterable by agent and outcome, linking to the thread when one exists. It
   answers "what happened while I was away".
5. **No Task object with its own chat.** Routines belong to agents; runs are
   activity rows. This removes the case where a task, a chat and a project file
   describe the same work.
6. **Naming**: auto-title from the first message, allow rename, title routine runs
   `<routine> — <date>`. Never title a thread with a model name.
7. **One search box** over threads, agents, projects, files and activity, with
   grouped results. Separate indexes are how Claude lost older Cowork tasks.

Net: agent-centric navigation, project as an optional label, activity as a global
log that also serves as the agent's run history.

## 5. Sources

- https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- https://learn.chatgpt.com/docs/automations?surface=app
- https://learn.chatgpt.com/docs/projects?surface=app
- https://support.claude.com/en/articles/9517075-what-are-projects
- https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- https://code.claude.com/docs/en/claude-projects
- https://support.google.com/gemini/answer/15146780
- https://support.google.com/gemini/answer/16316416
- https://www.perplexity.ai/help-center/en/articles/10352961-what-are-projects
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agents-overview
