# Unified threads — design

Status: decisions settled; no code yet.
Supersedes the conversation model in
`docs/specs/2026-10-18-persistent-agents.md` (§2, §3, §16 thread ownership).
Everything else in that spec still holds.

## End state

Every conversation is a thread of an agent. There is no plain-chat runtime.

- Each user has **one private personal agent**, created with the account.
  It cannot be shared and cannot be deleted.
- A user can create any number of additional agents. There is **no org cap**
  on agent count.
- A thread links three things: an **agent** (who works), a **user** (whose
  private conversation it is), and optionally a **project** (context).
- Each agent has **one workspace**, shared by every user who can use the
  agent. A private agent therefore has a private workspace.
- Threads are private to their user. Sharing an agent shares the workspace,
  never the threads.

## Decisions

1. **One runtime.** Every turn goes through the agent path and creates an
   `agent_run`. The plain-chat path and the model selector are removed. The
   composer shows an agent picker instead.
2. **Personal agent.** One per user, `visibility = private`, owner-only,
   created at signup (or first use), and exempt from deletion. It can be
   renamed. It can delegate to shared agents.
   - Default name: **Assistant**. The default model is the org's default
     model; the default tools are the safe baseline.
   - **Owner is a namespace.** The agent list shows `owner / name`. The agent
     selector shows `name` only. Two agents of different owners may share a
     name; the selector adds the owner label as secondary text when that
     happens.
   - Names are unique per owner (case-insensitive) among live agents:
     `UNIQUE (owner_user_id, lower(name)) WHERE status <> 'deleted'`.
3. **No agent cap.** `MAX_AGENTS_PER_ORG` is removed. Limits are per-agent
   workspace quota and an org storage budget, not a count.
4. **Thread privacy.** A thread is visible only to its `user_id`. Other users
   of a shared agent cannot list, read, or post into it. Admins cannot either.
   There is no per-thread share.
5. **One default thread per `(agent, user)`.** The unique index moves from
   `(agent_id) WHERE kind = 'default'` to `(agent_id, user_id) WHERE kind =
   'default'`.
6. **Per-agent workspace.** No per-user workspace. The agent's JuiceFS subpath
   is the only workspace. A shared agent's files are common to all its users.
   This is a stated product decision, not a leak to fix.
7. **Project is context, not owner.** A thread may carry `project_id` next to
   `agent_id`. The agent still owns the thread. The project folder is reached
   through a link, never merged into the agent workspace (see §Project
   access).
8. **Model on the agent.** The model is an agent property. There is no
   per-chat model override in this phase.
   - **Model labels follow the app's naming.** The stored value is the
     provider id (`deepseek-v4.1-flash`); every surface shows the org's alias
     from `/api/v1/models` (`Auto`). The raw id never appears in the UI.
   - A blank label holds until the model list loads, so a provider id never
     flashes on screen.
9. **Every run carries the user on whose behalf it happens.** For a user
   message that is the caller; for a routine or reminder it is the routine's
   creator; for a delegated child run it is the user who started the parent.
   Agent-initiated threads therefore belong to the routine's creator. A run
   never posts into another user's thread. Routines run in the agent
   workspace.
10. **Delegation inherits the initiating user.** The child run is private to
    that user. Delegating to a shared agent writes the task text and artifacts
    into that agent's shared workspace; the UI states this at delegation time.
11. **Shared-agent indicator.** The agent picker marks shared agents. A small
    icon sits next to the agent name. There is no persistent banner.
12. **Conversation tools are scoped.** `conversations_search` and
    `conversation_read` read only the calling user's threads.
13. **Read state and inbox stay per user**, per thread and per item.

## Data model

```
threads(
  id, org_id, agent_id, user_id, project_id?,
  kind ∈ default|thread|routine_run,
  title, title_locked,
  created_at, last_activity_at,
  archived_at?
)
UNIQUE (agent_id, user_id) WHERE kind = 'default'
INDEX  (user_id, last_activity_at DESC)
INDEX  (agent_id, last_activity_at DESC)
INDEX  (project_id, last_activity_at DESC)
```

`chats` stays as the journal owner: `threads.id = chats.id` for threads
created from a chat, and `thread_events.chat_id = threads.id`. `agent_threads`
is replaced by `threads`.

`agent_runs` keeps `thread_id` and gains `user_id`, so Activity and usage
roll up per user.

`agent_projects(agent_id, project_id, created_by, created_at)` records that an
agent may work in a project. The link is a permission, not a copy.

## Project access

Two roots in one turn:

| Root | Backing | Tools |
|---|---|---|
| `workspace` | the agent's JuiceFS subpath | `read`, `write`, `edit`, `bash`, `list` |
| `project` | the project folder on its machine | `project_read`, `project_write`, `project_edit`, `project_bash`, `project_list` |

- Workspace tools are always present. Project tools appear only when the
  thread carries a project, the agent is linked to it, and the machine is
  online.
- `project_*` calls run through the machine's executor socket, not the server
  sandbox. Two executors, two lifecycles.
- Access is the intersection of agent access, project access, and machine
  availability.
- The change journal keys paths by `(root, path)`.
- Artifacts always land in the agent workspace.

## Migration

1. Create one private personal agent per user. Name it from the user's display
   name. Idempotent, one transaction per user.
2. Create `threads` from `agent_threads` (keep ids) and from every `chats` row
   without an agent (id = chat id, `user_id = chats.user_id`).
3. Backfill `threads.user_id` from `chats.user_id` for agent threads.
4. Move the default-thread uniqueness to `(agent_id, user_id)`.
5. Route every turn through the agent path; remove the plain-chat runtime.
6. Remove `MAX_AGENTS_PER_ORG`.
7. Drop `agent_threads` after old thread URLs redirect.

## Future: multi-user threads

Multi-user threads are out of scope now. The model leaves room for them:

- `threads.user_id` is the **creator** and, for now, the only participant.
- A later `thread_participants(thread_id, user_id, role)` table replaces the
  single-user ACL. Listing, read state and inbox become participant-scoped.
- The default thread stays a per-user home thread of the agent; a shared
  thread would be `kind = 'shared'` with an explicit participant set.
- Runs keep their `user_id`, so attribution survives the change.

No other part of this design depends on a thread having exactly one user.

## Open items

- Agent picker placement: composer chip, rail, or both.
- Whether an archived thread can be restored into a different agent.
- Org storage budget for shared workspaces.
- Whether personal agents get a fixed display name or a generated one.
- When multi-user threads land, whether shared threads are created from a
  thread action or from an agent setting.
