# Unified IA for Guild: conversations, agents, activity

## 1. Five patterns

**1. An inbox is an attention queue, not a history.** Linear's Inbox holds only events on issues you follow. It splits Priority from Other, supports read/unread and snooze, and keeps filters. Notion's Inbox groups updates by page, collapses repeated updates under one page row, and has an "Automations & runs" type filter. Trade-off: a second list to maintain, and read state must live on the notification item, not the thread. Otherwise opening a thread clears unrelated alerts. For Guild: only events that need a human enter the Inbox. Silent runs never do.

**2. An entity is a member, not a destination.** Linear treats agents as workspace members: you assign them issues and @mention them in comments, and their work appears inside the issue thread. The agent profile is secondary. Trade-off: an agent's history becomes hard to read, so Linear also gives each agent a filterable list of assigned issues. For Guild: keep the agent page, pin its default thread at the top, and show the agent in every thread byline. Do not build a separate "agent chats" silo.

**3. Container vs tag is decided by ownership, not grouping.** A project is a container when it owns files, membership, defaults, or permissions. It is a tag when it only groups. Notion pages are containers because permissions inherit down the tree; Linear projects group issues but the team stays the owner, so they behave more like tags. Trade-off: containers add hierarchy and orphans; tags add ambiguity about who owns the files. For Guild: project = container for the persistent workspace and files, exactly one project per thread. Agent = filter, because one agent works across projects.

**4. Activity is an event stream with grouping, not a second inbox.** GitHub Actions keeps run lists readable with a stable shape: workflow in the sidebar, then runs with status icon, name, branch, and time, then a detail page with a job graph. Grouping by workflow keeps the list scannable. NN/g separates status trackers (pull, full history) from progress updates (push, state changes only). Offer both. Trade-off: grouping hides outliers; flat lists drown. For Guild: group Activity by day, then by agent or routine, and collapse consecutive silent runs into one expandable row ("12 silent runs").

**5. One object, one canonical URL; other surfaces are projections.** A Linear issue appears in Inbox, project, My Issues, and search, but every appearance opens the same issue URL. Notion collapses 20 comment updates on one page into one inbox row. Trade-off: repeated appearances read as duplicates unless icon, breadcrumb, and link are identical everywhere. For Guild: a thread has one URL; agent and project pages link to it, never embed a second copy. Search groups results by type and shows the canonical path.

## 2. Recommended primary navigation

Rail, top to bottom: **Inbox** (badge), **Chats**, **Agents**, **Projects**, **Skills**; Settings and Help stay at the bottom.

- **Inbox — page**, two tabs: *Needs you* (agent asked a question, routine posted a message, run failed) and *Activity* (full log). The badge counts only *Needs you*.
- **Chats — page**, one list of all threads with filter chips: All / Agents / Projects / Unread.
- **Agents — directory**. Agent detail has tabs: Overview, Threads (default pinned first), Runs, Routines.
- **Projects — directory**. Project detail has tabs: Threads, Agents, Files, Activity.
- **Skills — rail tab**, unchanged for now.
- **Search** — command palette; results grouped by Thread / Agent / Project / Run.

A run is a page under a thread or an agent, not a rail destination. Activity is the only feed. Inbox is a queue, not a feed.

## 3. How activity relates to threads and projects

Store one event stream, render four projections:

1. **Global Activity** — every event, grouped by day, then agent/routine, silent runs collapsed.
2. **Inbox** — only events with `needs_attention = true`; read, snooze, done per item.
3. **Agent → Runs** — events filtered by agent.
4. **Project → Activity** — events filtered by project.

Event fields: actor, verb, target, `visibility` (silent/surfaced), `needs_attention`, timestamp, run id. A surfaced routine message creates a thread and an inbox item; the run links to that thread. A silent run appears only in Activity and Agent → Runs.

Read state: inbox item read is not thread read. Inbox uses per-item read/snooze/done. Activity uses a per-user "last seen" cursor and a "since you were away" divider with counts. Show the digest on open, not as a push.

## 4. Naming rules for threads and runs

- **Thread title**: generated once, after the first assistant reply, from the first user message. 3–6 words, sentence case, no agent-name prefix, no "Chat about", no date. Example: "Fix flaky sandbox tests", not "Claude session 2026-05-04".
- **Fallback**: first six words of the first user message. Never show "New chat" in a list.
- **Rename pins the title**: set `title_locked = true`; the model never overwrites it. Use one inline control in the list row and the thread header (Guild has `RenameInput`).
- **No regeneration**: do not retitle on later messages. It costs a model call and disorients the user.
- **Run title**: `<routine or trigger> · <short target>`, e.g. "Nightly inbox triage". Status, duration, and time are fields, never inside the title. Number repeats: "Nightly inbox triage #14".
- **Agent and project names**: user-chosen, unique, never auto-renamed.

## 5. Sources

- Linear Inbox — https://linear.app/docs/inbox
- Linear notifications — https://linear.app/docs/notifications
- Linear Triage — https://linear.app/docs/triage
- Linear for Agents — https://linear.app/agents
- Notion Inbox and notifications — https://www.notion.com/help/updates-and-notifications
- GitHub notifications and subscriptions — https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications
- GitHub Actions run history — https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history
- GitHub Actions visualization graph — https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph
- NN/g, Status Trackers and Progress Updates — https://www.nngroup.com/articles/status-tracker-progress-update/
- NN/g, Transactional Notifications — https://www.nngroup.com/articles/transactional-notifications/
- NN/g, notifications topic index — https://www.nngroup.com/topic/notifications/
