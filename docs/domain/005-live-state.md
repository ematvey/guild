# 005 Live state

This document explains how what the server knows reaches what a person sees. It covers the member socket, frames, push notifications and addresses. It builds on [001 Domain model](001-domain.md) through [004 Capabilities](004-capabilities.md).

## The rule

**The server pushes every fact a person sees change; the client applies it and never re-fetches.**

That covers messages, Turn progress, Run status, the Thread list, the agent tree, unread state, Machine presence, the Agent list, Routines, the skill catalog, the model list and the Member's own profile. An HTTP read may seed the first paint. After that the socket is the only live source: no timers, no interval refetch, no refresh on focus. A new display fact is not done until it has a frame, a push site in the server and a handler in the client.

Two kinds of data stay as reads, because they are not live state:

- **Windowed analytics:** traces, spans and usage over a time range. They have a Refresh button.
- **Admin editing lists:** users, Teams, Integrations, routes and SSO. They are read when opened, and the admin who edits them is the one viewing them.

## Concepts

| Concept | Definition | Rules it keeps | Why it exists |
| --- | --- | --- | --- |
| Member socket | A client's one WebSocket to the server | Opened with a single-use connect ticket. At most 32 sockets per Member. Pinged every 5 s and closed after 10 s of silence. Each client message rechecks the session | One channel for all live state |
| Frame | One tagged message on a socket | Every tag is declared in `protocol/socket.schema.json` with a fixture. A reader ignores unknown tags and fields, and never fails a frame for what it does not know | A typed contract that older clients survive |
| Sync | The bracket in which a client asks for one Thread and receives its authoritative view | `sync_begin` … `sync_done`. Holds back deferred frames until the bracket closes. Names the socket's shown Thread | A first view consistent with what follows it |
| Shown Thread | The Thread a socket's latest Sync named | Thread-view frames go only to sockets showing that Thread. A socket that never syncs receives every Thread of its Member | A socket gets only what it displays |
| Read marker | A Member's highest read event of a Thread | Moves only forward. A client sets it only while the Thread is open, visible and its window has focus, and again when the window regains focus | Unread state, and the presence signal for notifications |
| Push subscription | A browser or device registered for Web Push | Removed when the push service reports it gone | Tells a Member a Run ended when no client is watching |

## Frames and where they go

| Scope | Frames |
| --- | --- |
| Sockets showing the Thread | `thread_state`, `thread_events`, `live_frame`, `context_usage` |
| Every socket of the Thread's Member | `chat_status`, `chat_row`, `thread_list`, `archived_thread_list`, `subagent_tree`, `chat_tree`, `project_list`, `machine_list` |
| The Member's member sockets | `machine_status`, `member_profile`, `integration_access` (the Integrations they may add to an Agent, re-sent when an audience, a grant or a team membership moves) |
| Members who may see the Agent or Skill | `agent_list`, `agent_run`, `agent_threads`, `agent_routines`, `skill_catalog` |
| Every socket of the Org | `org_event`, `workspace_identity`, `model_list` |
| One socket | `hello`, `pong`, `error`, `sync_begin`, `sync_done`, `auth_required`, `displaced` |
| One Machine | `tool_dispatch`, `tool_cancel`, `machine_request` |

A client sends `sync`, `read` and `ping`. A Machine also sends `tool_result` and `machine_response`.

### The first view

On connect the server sends `hello`, then the Member's workspace (Threads, Projects, Machines, identity, models, profile), then the Agent list (with each Agent's Integration warnings), the Integrations the Member may attach, and the skill catalog. To show a Thread, the client sends `sync`. Inside the bracket the server:

1. Checks read access.
2. Sends the Thread's tree and context usage.
3. Sends `thread_state`: the newest 120 events, whether older ones exist, the unsaved text and thinking of a running Step, `generating`, `compacting`, and the Project.

Frames that would race the view are held until the bracket closes: `error`, `chat_status`, `live_frame`, `org_event`, `subagent_tree`, `chat_tree` and `context_usage`. Every other frame goes out at once. Each new frame tag takes its place in this classification (`DEFERRED_UNTIL_SYNC`).

### The durable log and the live stream

Two streams reach a shown Thread:

- `thread_events` carries durable rows past the client's sequence number.
- `live_frame` carries a running Step's text, thinking and tool progress. It is never stored. It comes straight from the running Turn and is stamped with the current sequence number.

Both go through the Thread's one ordered chain, so a durable row never overtakes its own live frames. A client drops a `thread_state` that is not newer than the one it holds.

### From a write to a frame

A write that changes display state notifies a Postgres channel in the same statement or transaction. Some channels are raised by code at the write site. Others are raised by table triggers on Agents, Runs, Routines, Threads, grants, team membership, chat flags, Skills and profiles, so a new write site cannot forget them. One forwarder listens and turns each notification into frames for the Members allowed to see them.

Two facts do not travel through Postgres:

- **Machine presence** lives in the server's socket registry, and the registry raises it directly.
- **Live frames** come straight from the running Turn.

Bursts are shaped:

- A changed Thread view is republished after one quiet 100 ms tick, or after 300 ms at most, and only if it differs from what was sent.
- Agent-list and skill-catalog pushes coalesce over 50 ms quiet, or 250 ms at most.
- Each socket remembers what it already holds and skips identical frames. A Thread list that keeps its rows and order goes out as single `chat_row` frames to clients that declared support for them.

When the Postgres listener reconnects, the forwarder re-pushes the workspace, Agent and skill state of every connected Member and re-captures every shown Thread.

### Unread and notifications

A Thread is unread when it is not generating and has an assistant message past the Member's read marker. Moving the marker re-pushes the Member's Thread lists.

When a Turn ends, the server waits four seconds. If the read marker has not reached the Turn's last event, it sends one Web Push per device: at most one per Thread every 20 seconds, with one topic per Thread so they replace each other. The push names the Thread and how the Run ended, never its content. Opening the app syncs.

## Machines on the socket

A Machine connects on the same endpoint with its id and an instance id. It is online exactly while it holds its slot:

- A second instance is refused with `displaced`.
- A reconnect of the same instance replaces its own stale slot.
- Only a first claim or a release changes presence and pushes `machine_status`.

Skills are not sent over the socket. The Machine pulls them over HTTP (see 004).

## Addresses

All navigation state is URL state. The route model parses the path into a `ChatRoute` and applies changes as patches, and one function writes every history entry. A discrete pick pushes an entry; a text filter or a normalizing rewrite replaces one. A deep link, a reload and back or forward all land where the Member was. An unknown address is replaced by the page actually shown.

## The client

The client keeps server state in stores that only frames write. Seeds from HTTP fill a store the socket has not filled yet, and a frame always wins over a seed. Sign-out resets every store at once.

The only state the client owns is a pending send and the Member's drafts. A pending send retires when a frame speaks for that Thread. `busy` is derived from `generating` and the pending send; it is never stored.

On every reconnect the client clears its watermarks and syncs again. When it wakes or becomes visible, it checks the socket and syncs; it never calls HTTP.

## Rejected

| Rejected | Reason |
| --- | --- |
| Polling, interval refetch, refresh on focus | State goes stale between polls, and a hung client cannot be told apart from a quiet one |
| A second stream for Thread updates (SSE) | Two transports drift. The member socket is the only push path |
| Re-sending the whole workspace on every change | It cost about 90 KB per Turn. A per-socket diff sends only what changed |
| Sending every Thread's view to every socket | A socket on another page received megabytes it never displayed |
| Notifying whenever no socket is open | An open but unwatched app is not presence; the read marker is |
| Push content in the notification | A push is a hint. The content stays on the server until the app syncs |
