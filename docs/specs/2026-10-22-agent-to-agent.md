# Agent-to-agent — design

Status: decisions settling; no code yet.

Extends `2026-10-21-unified-threads.md` (the thread model) and replaces the
delegation section of `2026-10-18-persistent-agents.md` (decisions 17–19).

This doc is written before code. It records the decisions reached in review,
with the code each one replaces. Open items are listed at the end.

## End state

An agent can spawn another agent. The spawn creates a **thread**, and that
thread is the node in an **actor tree** rooted at the user.

- The spawner talks to the child by posting turns into the child thread.
- The child talks to the spawner by **ending its turn**. The end of the turn
  is delivered to the parent as a message in the parent's inbox.
- A child can be read, cancelled and closed, but never receives an upward
  message from below.
- Files travel as **attachments on messages**, in both directions.
- No file is copied into a workspace. The workspace holds working state only.

The mechanism is one mechanism for every pair: user to agent, agent to agent,
agent to user. Only the participants differ.

## Decisions

1. **The thread is the tree node.** A spawn creates exactly one thread. There
   is no separate "session" or "call" noun.
   - Evidence: `delegate` already creates one thread per delegation
     (`apps/server/src/agents/delegation.ts:365`), but labels it `routine_run`.
     The noun already exists; the label is wrong.

2. **A spawned thread belongs to the spawning agent.** Access follows the
   actor tree: the root of the tree is the user, so the user can read every
   thread under it. This replaces the single-owner rule for these threads.
   - Consequence: `docs/specs/2026-10-21-unified-threads.md` decision 4
     ("visible only to its `user_id`") stays true for the root, and becomes a
     subtree rule for the rest.

3. **Downward messages are turns.** The parent posts a turn into the child
   thread through the same admission path a user message uses
   (`GuildRuntime.submitTurn`).

4. **Upward messages are turn ends.** A child speaks only by ending its turn.
   The end of the turn, with its final text and its attachments, is delivered
   to the parent thread as a message. A child that needs a decision ends its
   turn with the question. There is no separate `needs_input` channel.

5. **No `wait` tool.** The parent never blocks on a child. It ends its turn
   and is woken by the delivery.
   - This removes `waitForRun` (`delegation.ts:212`), its 250 ms poll loop, and
     `DEFAULT_DELEGATION_TIMEOUT_MS`. `waitForRun` takes no abort signal, so a
     blocked `delegate` cannot be stopped today; that defect goes with it.

6. **Delivery is a steer input, not a queued follow-up.** A delivery is placed
   at the next model-call boundary. It never aborts a running generation, and
   it never waits for the turn to end.
   - Mechanism already present: `whenBusy: "steer"` on
     `conversation.submit` (`apps/server/src/harness/runtime.ts:1475`), with
     `steeringMode: "one-at-a-time"` (`runtime.ts:795`).

7. **Pending deliveries drain as one message, merged in the inbox item.** When
   the parent reaches a boundary (or becomes idle), all unconsumed deliveries
   become one message.
   - The batch is durable state, not a clock: `thread_events.consumed_by_run_id`
     records which run took which delivery. No debounce, no TTL, no timer.
   - A delivery writes an event. It never enqueues a turn. Only the boundary
     enqueues a turn, and at most one.
   - Merge point: the pending inbox item's `content`. A delivery appends its
     text to the item of ours that is still unplaced. One item, one placement,
     one model call, however many children finished.
   - The mutation is a doc-draft write, the same shape `steerQueued` already
     uses for `item.mode` (`runtime.ts:1492`), but on content. This is not a
     documented operation, so it needs its own test. If it proves fragile, the
     fallback is a one-line pointer plus a read tool, at the cost of one model
     call.

8. **`cancel` is turn-level and cascades.** `cancel(thread_id)` stops the
   in-flight turns of the thread and every descendant. The nodes stay alive and
   addressable; the parent can post another turn.
   - Adds `cancelled` to the run status set. Today the set is
     `succeeded | failed | silent | skipped` (`delegation.ts:31`), so a stopped
     child is indistinguishable from a silent one.

9. **`close` is separate and terminal.** `close(thread_id)` cancels the subtree,
   stamps `closed_at`, stops deliveries to the parent, and keeps rows and
   attachments. The thread is archived, not deleted and not promoted to a
   standalone thread.
   - The `parent_thread_id` link stays as history.

10. **A user cancel is delivered upward.** A cancel by the user is delivered to
    the parent with `status: cancelled` and `reason: user`, so the parent can
    tell "the human stopped it" from "I stopped it".

11. **The user can read and cancel, not post.** The "delegated to X" row in the
    parent transcript opens the child thread. The user reads it and can cancel
    it or its subtree. The user cannot post into it.
    - The authority direction stays one-way. A human posting into an
      agent-owned thread would be an upward edge.

12. **Files are attachments on messages, in both directions.** One table, one
    download route, one materialization rule.
    - Inbound: a user upload is an attachment on the user event.
    - Outbound: an agent file is an attachment on the agent event.
    - Direction is a property of the message, not a reason for a second table.
    - `tool_artifacts` stays separate: it is a spilled tool result, not a
      message attachment.

13. **`send_file` snapshots at call time.** The tool reads the file, hashes it,
    uploads it to object storage immediately, and records a pending attachment
    bound to the running turn. Turn end publishes it onto the assistant event.
    - The row keeps both the storage key and the source workspace path, so the
      UI can say "from `reports/build.html`" while the bytes are frozen.
    - Immutability matches the existing contract for the reverse direction
      ("attachment's bytes are part of the immutable user message",
      `apps/server/src/chats/turn-text.ts:152`).
    - A failed upload fails the tool call inside the turn, where the model can
      react, not at turn end where nothing can.

14. **Files materialize per turn, outside the workspace.** Files attached to a
    message materialize at `/tmp/attachments/<runId>/…` for the turn that
    consumes the message. The directory is wiped at the start of each turn.
    - The rule applies to user uploads and child deliveries alike.
    - `/tmp` is already a 1 GiB tmpfs in the sandbox
      (`apps/server/src/sandbox/runner/spec.ts:119`), so this needs no new mount.
    - Turn scoping is required for correctness, not tidiness: one sandbox serves
      every thread of an agent, including threads of different users on a shared
      agent. A chat-scoped or agent-scoped path would leak one user's files into
      another user's turn.
    - Object storage stays the truth. The directory is a cache.

15. **Nothing is copied into a workspace.** `transferArtifacts`, the 16 MiB
    inbox threshold, the `/tmp/delegations` staging root and `release_artifacts`
    all disappear.
    - The staging root was never durable: no compose file mounts `/tmp`
      (`deploy/compose/*.yml` mounts `guild_workspaces` only), so staged files
      die with the container while `agent_delegation_artifacts` still reports
      them as `staged`.
    - `outboxFiles` (`delegation.ts:461`) is exported and never called. It goes.

16. **The subagent UI is one compact row per spawn.** In the parent transcript:
    agent name, status dot, elapsed time computed on the client from
    `started_at`, and one chevron that opens the child thread. No cards, no
    nested transcript, no header strip.
    - No new field on the `ThreadState` frame. The row is correct when it is
      written and correct again when the delivery lands. The only thing a frame
      could add is a live elapsed counter, which the client computes itself.

17. **Limits are depth and child count only.** Depth 3. Max children per node
    16. Both are configuration, not constants in the source.
    - Replaces `MAX_DELEGATION_DEPTH = 2` and `MAX_CHILDREN_PER_RUN = 3`
      (`delegation.ts:29-30`).
    - Children are counted **per node**, not per turn. `childCount` counts per
      parent run today (`delegation.ts:442`), which does not bound a tree that
      can be woken indefinitely.
    - **No token, turn or wall-time budget for now.** The tree is bounded by
      shape only. A budget can be added later on the root thread; it is not part
      of this design.

18. **`close` keeps the bytes.** `close` archives the subtree rows and stops
    deliveries. It does not delete attachment objects.
    - The parent transcript keeps the delivered message, which references the
      attachment. Deleting the bytes leaves a message whose file is gone — the
      state the current code tolerates but calls out as a defect
      (`turn-text.ts:174`, "a missing object is tolerated (the row exists, the
      upload does not)").
    - Storage cost belongs to the org storage budget, not to thread lifecycle.
    - Nothing is reclaimed on JuiceFS either: decision 15 means no deliverable
      is ever copied into a workspace.
    - How the bytes are eventually deleted is an open item ("Overall cleanup").

19. **The tree tools ship as one grantable group.** One allowlist entry,
    `subagents`, grants `spawn`, `send`, `read`, `list`, `cancel` and `close`.
    `send_file` stays a separate entry.
    - A model that can spawn but not cancel or close leaves trees it cannot
      clean up, which is worse than a coarse allowlist.
    - `send_file` is the only tool here that an assistant talking to a user
      needs, and it has nothing to do with the tree.

20. **A spawned child gets tree context, not the parent transcript.** The child
    prompt carries one `<spawned_by>` block: the spawning agent, the depth,
    whether it may spawn further children, and how to reply.
    - The reply rule is stated plainly: **ending the turn is how the child talks
      to the spawner**. Its final text, plus any `send_file` attachments, is
      delivered to the parent thread. To ask a question, the child ends its turn
      with the question.
    - The parent transcript is never included. That is the existing contract
      (`delegation.ts:517`, persistent-agents decision 17).
    - Without this block a child may try `send_message` to the user directly, or
      wait for input that will never come.
    - It fits the existing context shape: `<agent_workspace>` and
      `<project_context>` are already rendered the same way.

21. **Archiving the root closes the subtree.** The same cascade as `close`:
    in-flight turns in the subtree are cancelled, every descendant gets
    `closed_at`, and deliveries stop.
    - Reuses the existing rule instead of adding a third state.
    - Prevents work that nobody will read: a child delivering into an archived
      thread spends tokens for no reader.
    - Restore then means "the story is back", which is what archiving already
      means for a chat's events.

## The tree

```
user
└── thread A (agent: Assistant)        root: the user's own conversation
    ├── thread B (agent: Researcher)   spawned by A
    │   └── thread C (agent: Coder)    spawned by B
    └── thread D (agent: Researcher)   spawned by A, separate node
```

Invariants:

- One thread per spawn. Two spawns of the same agent are two nodes.
- `depth` is a real tree depth. `parent_thread_id` is the only tree edge.
- Access flows down: a node can read and act on its subtree. Nothing flows up
  except turn-end deliveries.
- A subtree is cancelled and closed as a unit.

## Delivery

1. A child run reaches a terminal status.
2. The server writes one `thread_events` row in the **parent** thread:
   `kind = child_result`, `author_kind = agent`, payload
   `{thread_id, run_id, status, reason, final_text, attachments}`,
   `consumed_by_run_id = NULL`.
3. The server places one steer input for the parent, unless one is already
   pending and unplaced.
4. At the next boundary, the run consumes every unconsumed `child_result` row
   in one transaction and marks it with its own run id.
5. The parent sees one message listing every result, with timestamps.

If the parent is idle when the delivery arrives, step 4 happens at once and the
delivery starts a turn.

## Files

| direction | row | bytes | materialization |
|---|---|---|---|
| user → agent | attachment on the user event | object storage | `/tmp/attachments/<runId>/` |
| agent → agent | attachment on the child result | object storage | `/tmp/attachments/<runId>/` |
| agent → user | attachment on the assistant event | object storage | client download route |

Object key follows the existing shape: `attachments/<org>/<id>/<filename>`
(`apps/server/src/platform/store/attachments.ts:41`).

## Tool surface

| tool | meaning |
|---|---|
| `spawn(agent, task, name?)` | create a child thread, post the first turn, return `{thread_id, run_id, chat_id, title}` at once |
| `send(thread_id, text)` | post a turn into a child thread |
| `read_thread(thread_id)` | read a bounded excerpt of a child thread |
| `list()` | list children with status, depth and elapsed time |
| `cancel(thread_id)` | stop in-flight turns in the subtree, keep the nodes |
| `close(thread_id)` | cancel the subtree, archive it, stop deliveries |
| `send_file(path, as?)` | attach a file to this turn's response |

Removed: `delegate`, `release_artifacts`.

The read tool is `read_thread`, not `read`: a tool named `read` shadows the
coding `read` in the registry and silently removes it from the direct tool
list. `list` does not collide, so it keeps the plain name.

## Data model

```
threads
  + parent_thread_id  UUID NULL REFERENCES threads(id)
  + depth             INT NOT NULL DEFAULT 0
  + closed_at         TIMESTAMPTZ NULL
  kind                += 'delegated'

thread_events
  + kind              += 'child_result'
  + consumed_by_run_id UUID NULL REFERENCES agent_runs(id)

attachments
  + event_id          UUID NOT NULL REFERENCES thread_events(id)
  + author_kind       TEXT NOT NULL CHECK (author_kind IN ('user','agent'))
  + author_id         UUID NOT NULL
  + source_path       TEXT NULL      -- workspace path, for provenance
  (chat_id stays; bytes stay in object storage under the derived key)

agent_runs
  + status            += 'cancelled'
```

`agent_delegation_artifacts` is dropped after backfill.

## Migration

1. Add the columns. Backfill `depth = 0`, `parent_thread_id = NULL` for
   existing threads.
2. Relabel existing delegation threads from `routine_run` to `delegated`. They
   are identified by a `parent_run_id` on their run with trigger `delegation`.
3. Backfill `attachments.event_id` from the event that carried the attachment
   ids.
4. Replace the `delegate` tool with `spawn`. Remove `release_artifacts` from the
   tool catalog and from every agent's allowlist.
5. Drop `agent_delegation_artifacts` after copying its rows to `attachments`.

## Open items

- **Overall cleanup.** `close` keeps the bytes (decision 18). Nothing in this
  design deletes attachment objects or archived subtree rows. Decide the
  cleanup story as a whole: org storage budget only, a retention policy, or a
  user-driven delete. This is deliberately left out of the tree design so the
  two questions do not block each other.
- **Cross-worker stop.** `stopChat(chatId)` exists and is chat-agnostic
  (`runtime.ts:1575`), but worker mode has `remoteSubmit` and no `remoteStop`
  (`apps/server/src/platform/context.ts:200`). `cancel` across workers needs
  that IPC.

## Addendum: identity, directory, child chat ownership

First use of the tree showed three gaps. A spawner cannot discover what exists:
`spawn` takes a name and fails silently when the name is wrong, and the only
spawnable agent is the caller's own copy. The child row does not open the child
chat. Child chats leak into the user's sidebar.

30. **An agent has a description.** `agents.description text NOT NULL DEFAULT ''`,
    at most 500 characters, set by its owner in the create form and in the agent
    settings. The description is how another agent identifies what this agent is
    for; the name alone is not enough.
31. **The description is part of the agent's own prompt.** The first line of the
    instructions becomes `You are <name>, <description>.` The owner writes the
    starting text; the agent lives with it.
32. **An agent may rewrite its own description** with `set_description`. The tool
    is outside the allowlist and available to every agent. It writes
    `agents.description` for the calling agent only, so a spawner can steer a
    child's identity and a child can correct what it learned about itself.
33. **`list_agents` is the directory, inside the `subagents` group.** It returns
    every agent the caller's user may use: all non-personal agents visible to
    that user, plus that user's own personal agent. Another user's personal agent
    never appears, not even to an admin. Each entry is
    `{id, name, description, personal}`.
34. **A failed spawn names the directory.** `target_not_found` and
    `target_unavailable` carry the hint to call `list_agents` first.
35. **A child chat belongs to its parent thread, not to the user's chat list.**
    `chats.user_id` stays the run owner, so the child runs as that user. Every
    chat list excludes a chat whose thread is `delegated`: the HTTP list and the
    WebSocket `thread_list` push use one predicate. Today the push does not
    filter, which is why child chats reach the sidebar.
36. **The child row opens the child chat.** `child_result` carries `chat_id`, and
    the `spawn`/`send` tool result carries `chat_id`, `agent_name` and `status`.
    The reducer never uses a thread id as a chat id; the row navigates to
    `/thread/<chatId>`.
37a. **The spawner names the session.** `spawn` takes an optional `name` of at
    most 80 characters; it becomes the child thread's title and is locked, so a
    later title regeneration cannot overwrite it. Without a name the first line
    of the task is the fallback label. The row shows the session name first and
    the agent's own name beside it, so two children of the same agent stay
    distinguishable.

37. **Subagent rows are pinned above the composer.** The children of the open
    chat render as one quiet strip directly above the composer, with a count,
    a height cap and its own scroll, so they stay visible while the
    conversation scrolls. The thread body keeps only the turn's text and tool
    cards. The whole row opens the child chat; cancel and close stay on hover.
    A child thread opened on its own shows a read-only notice instead of the
    composer, because only the parent agent drives it.

Out of scope, recorded for later: an org agent or another user's agent sending
a message to a person's assistant as a notification. The tree stays
parent-to-child only.

## Addendum: the strip is server truth

38. **A child row exists because the server said so.** `spawn` and `send` write a
    `child_spawned` event into the parent chat after the child turn is admitted:
    `{thread_id, run_id, chat_id, agent_name, title, status}`. The client builds
    the strip from that event and updates it from `child_result`. A tool block
    never creates a row, so a spawn that failed, was retried, or ran inside a
    codemode script cannot leave a row stuck at "running".
39. **A child chat carries the request that started it.** `spawn` and `send`
    append the task text as a `user_message` in the child chat before submitting
    the turn, so the child thread opens with the parent's request as its first
    message instead of an answer with no question.
40. **A child thread's header is the navigation.** The header shows, left to
    right: a back control labelled with the parent chat's title, the child's
    session name, its agent name, and the run status. The data comes from
    `GET /api/v1/chats/:id/tree` — `{chat_id, kind, title, agent_id,
    agent_name, status, depth, parent}`. A plain chat keeps its normal header.
41. **The chat owns the stop.** `POST /api/v1/threads/:id/cancel` stops the
    subtree's turns and leaves the nodes addressable; `POST
    /api/v1/threads/:id/close` also stamps `closed_at`, which drops late
    results. Both authorize the chat first. `close` refuses a root thread —
    the conversation the caller is having is stopped, not closed. A cancel
    that cannot interrupt a turn in another worker still marks the run
    cancelled, and delivery reports that run as `cancelled` whatever the
    worker later says.
42. **The subagent panel collapses.** The strip keeps its header (`Subagents`,
    count, running count) when collapsed, and the choice persists in
    `localStorage`.
43. **A close is durable, and the pane can filter.** `close` appends
    `child_closed {thread_id}` to the parent chat, so the row stays Closed
    after a reload instead of reverting to the status of its last result.
    `child_result` carries `started_at`, so a row rebuilt from the result
    alone still shows its duration rather than `0s`. The pane switches between
    `Active` (closed rows hidden) and `All`, and the choice persists.
