# 003 Execution

This document follows work from an Input to a settled Run: the Turn and its Steps, where Tool calls run, the agent tree, Routines, and recovery. It builds on [001 Domain model](001-domain.md) and [002 Access](002-access.md).

## A Turn

### Submission

A Member's message carries a message id, and that id names the submission. A repeat with the same id and the same request returns the first result. A repeat with a different request is refused as `command_id_conflict`. The check runs before anything else, so a retried send never admits twice.

A Thread with no Agent is adopted by the sender's personal Agent here. The server then:

1. Marks the Thread `generating`.
2. Writes the Turn command and the user message event in one transaction. The message is marked `queued` if a Turn was already running.
3. Opens a Run.
4. Admits the Input.

A failure before admission fails the command and recomputes `generating`.

### Admission and placement

Admissions are serialized per Thread. Admission provisions the Turn's Tools, stores the Project instructions, configures the Agent's model and submits the Input with the message id as its request id.

An Input is placed by its mode:

| Placement | When it reaches the model |
| --- | --- |
| steer | At the next tool boundary of the running Turn, joining it |
| followUp | After the running Turn ends, starting the next Turn (the default for a Member's message) |
| write | After the running Turn ends, as a log entry; only compaction summaries are written |

Steers and follow-ups are taken one at a time. When a Thread has no running Turn, waiting Inputs are drained in order: writes first, then the first steer and the first follow-up as one new Turn. Draining never invents an Input.

A Member can act on a queued Input or a running Turn through Turn commands:

| Command | Effect |
| --- | --- |
| stop | Cancels pending admission, cancels child Runs and aborts the Turn at the next Step |
| steer | Moves a queued follow-up into the running Turn |
| withdraw | Removes a queued Input that is not yet placed |

A Turn command goes `pending` → `submitted` → `running` → `completed`, `failed` or `cancelled`. A pending command older than 15 minutes fails.

### Steps and the end of a Turn

A Turn is a sequence of Steps. Each Step is one model call through the Org gateway, and its Tool calls run before the next Step. The Turn ends at an assistant message that has no Tool call, or that has an error. Its Run then settles once:

| Run status | Condition |
| --- | --- |
| failed | The Turn ended in an error, or the Run was orphaned (see Recovery) |
| succeeded | The Turn ended with final text, or the Agent sent a message during it |
| silent | Neither: the Turn finished and said nothing |
| cancelled | A stop, or a cancel of its subtree |
| skipped | A wake found nothing to deliver |

`generating` on a Thread is derived, not set by hand: it holds while the Thread has a live Turn task or a queued submission. A Thread is shown as working while it, or any Thread under it, has a queued or running Run.

### Context

The system prompt of a Turn has two parts:

- **The Guild sections**, the same for every Agent of the Org:
  - the Org's assistant prompt, or the built-in persona;
  - the Member the Thread belongs to;
  - the Skills index;
  - the notes on calling Integration tools through code mode.
- **The Agent's instructions:**
  - who the Agent is and whether its Workspace is shared;
  - `AGENTS.override.md` or `AGENTS.md`, then `MEMORY.md`, from the Workspace;
  - one block for each situation that applies: a Routine Run, a feed Thread, a spawned child, a Thread an Agent opened, a Machine-bound Thread, and the Project instructions.

The Workspace files are read again at every admission and resume, so an Agent that edits them changes its next Turn. They are capped at 32 KiB together. Project instructions come from the Member's Machine: `AGENTS.md` files from the git root to the working directory, plus `MEMORY.md`. They are stored with the Thread so that a resumed Turn keeps them.

Attachments become part of the message. Document text is inlined, images go as image parts when the model accepts them, and other media get a note. The bytes are also materialized at `/tmp/attachments/<run>/`. That directory is wiped at the start of each Turn.

Compaction replaces the older context with a summary. It runs automatically, or on request, and its summary waits for the running Turn to end. Context usage is the token count of the last completed model call since the last compaction.

## Where Tool calls run

| Thread | File and shell tools | Workspace |
| --- | --- | --- |
| Not bound to a Project | `read`, `write`, `edit`, `bash` in the Agent's sandbox, on its Workspace | The same tools |
| Bound to a Project | `read`, `write`, `edit`, `bash` on the Project's Machine, in the Project folder | `agent_read`, `agent_write`, `agent_edit`, `agent_bash` in the sandbox |

**Sandbox.** One gVisor container per Agent, with the Workspace mounted read-write. It serves every Thread of that Agent, including Threads of different Members. An Agent's sandbox is always on: the idle reaper skips it, and it is stopped only to free capacity. Bytes leave the sandbox only as Attachments or Tool artifacts. The server reads the Workspace without following links, so a link planted inside the sandbox never resolves on the server.

**Machine.** A Tool call goes out on the Machine link as a dispatch and comes back as a result. If no live link holds the Machine, the call fails at once as `machine offline`. A result from a link that no longer holds the Machine is dropped. When a Machine reconnects, or its old link is unregistered, every call pending on the old link settles as "execution outcome is unknown; do not retry". The Agent must check before repeating anything outside the server.

**Large results.** A tool result over 64 KiB is saved as a Tool artifact. The Thread event shows a pointer to it, and the model's context keeps the whole result.

**Shared Workspace.** Turns of one Agent may run in parallel on its Workspace. Each Run records the paths it writes. When a Turn writes a path that another live Turn of the same Agent also wrote, the writer gets a warning on its tool result. The other Turn gets one system message if it started earlier. The Member is not told: the Agent resolves its own conflict.

## The agent tree

An Agent with the `subagents` tool can spawn other Agents. Each spawn creates one child Thread, which is one node of a tree rooted in the Member's Thread.

| Tool | Effect |
| --- | --- |
| `spawn(agent, task)` | Creates a child Thread and starts its first Turn; returns at once |
| `send(thread, text)` | Posts a Turn into an open child Thread |
| `read_thread`, `list`, `list_agents` | Read the subtree and the visible Agents |
| `cancel(thread)` | Stops every Turn in the subtree; the nodes stay addressable |
| `close(thread)` | Cancels the subtree, marks every node closed and stops its deliveries |

The tree is bounded by its shape: depth 3 and 16 children per node, both set in configuration. The child limit is checked under the parent's lock. A child gets a `<spawned_by>` block and the task, never the parent's transcript.

**Downward messages are Turns. Upward messages are Turn ends.** When a child Run settles, its final text, its status and its Attachments are written to the parent Thread as one child result. Nothing is written when the child or the parent is closed. The parent is then woken:

1. If the parent has a running Turn, the unconsumed results are placed as one steer, merged into a pending steer if there is one.
2. If the parent is idle, a new Run starts with them.
3. Each result is marked with the Run that took it, so a result is consumed once.

A parent never waits on a child; it ends its Turn and is woken by the delivery. A child that needs a decision ends its Turn with the question. A stop by the Member reaches the parent as `cancelled`.

`send_file` snapshots a Workspace file (up to 64 MiB) into object storage during the Turn. At Turn end it is published on the assistant message, and it travels with a child result.

## Routines

A Routine is `cron` (a five-field expression with a timezone; "every N" is written as cron, at least one minute apart) or `once`. An Agent sets a reminder with `schedule_reminder`, which creates a `once` Routine. At most 20 reminders can be pending per Agent.

The scheduler ticks every 15 seconds. For each due instant it creates an Occurrence. If several instants were missed, only the latest runs and the older ones are `skipped`. Claiming an Occurrence locks it, so it runs once across processes. A claim with no Run after two minutes returns to `pending`.

| Run outcome | Occurrence |
| --- | --- |
| succeeded, silent, skipped | `done`; a `once` Routine retires |
| failed | Retried after 30 s, 1 min and 5 min; after three attempts `failed`, with a `routine_failed` Notice |
| Refused at start (lost access, inactive Agent) | `failed` at once, with a Notice |

Ten failed Occurrences in a row disable the Routine and write a `routine_disabled` Notice.

Each Routine Run gets a new, hidden `routine` Thread, owned by the creator. It sees the Routine prompt, the Workspace and the conversation tools, not any other Thread's transcript. Its final text goes nowhere: the Agent speaks only through `send_message`. A Run that sends nothing ends `silent` and shows only in Activity. Each message lands by the Routine's delivery:

- `thread` (default): appended to the Routine's one feed Thread for that Member. If the feed is archived, deleted or closed, a new feed opens. If the feed is mid-Turn, the message goes to a separate marked Thread.
- `new_chat`: one new Thread per message.

Each message also writes an `agent_message` Notice.

## Durability and recovery

**The journal is the truth.** Each Thread maps to one durable conversation, created once. Every Input, Step, Tool call and result is a journal entry before it has effects. Thread events are a projection of that journal: each entry is copied once, behind a stored cursor. The Run and Turn command rows are reconciled from it the same way.

**Hosts reopen.** A conversation's host reopens after a failure with backoff (0, 1 s, 5 s, 30 s) and resumes. In worker mode, each active Thread has its own forked worker process. The supervisor respawns a dead worker only when the journal still holds pending work. It kills a worker that stops reporting its heartbeat for 90 seconds, or that ignores a stop for 10 seconds.

**Restart.** At start the server:

1. Repairs damaged projections.
2. Attaches only Threads that hold journal work, and resumes them.
3. Drains idle Inputs.
4. Recomputes `generating`.
5. Fails expired Turn commands.

A Turn cut off mid-Step resumes from its last recorded entry. A Tool call cut off on a Machine settles as unknown (see above).

**Orphans.** Every five minutes, a sweep fails Runs that are still queued or running, whose Thread has had no event for ten minutes and holds no journal work. Such a Run ends `failed` with `orphaned`. An orphaned child also delivers a failed result to its parent. Child results left unconsumed for two minutes are delivered again.

## Rejected

| Rejected | Reason |
| --- | --- |
| A delivery that aborts the parent's running generation | A steer waits for the next tool boundary, so no work is thrown away |
| A debounce or timer that batches child results | The batch is durable state: results stay unconsumed until a Run takes them |
| Replaying Thread history into a lost durable conversation | The journal is the truth. A missing conversation starts empty instead of being reconstructed from a projection |
| Retrying a Machine Tool call whose outcome is unknown | It may have run. The Agent checks before acting again |
| A Routine Run reading the default Thread's transcript | Routine context is isolated. The Agent searches its conversations when it needs them |
| One Thread per Routine message by default | An hourly Routine would fill the sidebar. The feed Thread holds them |

## Known gaps

- The workspace change journal keys paths without their root. On Project-bound Threads it records `write` on the Machine and misses `agent_write` in the sandbox.
- Event sources (webhooks, chat messages) cannot trigger a Routine yet; only time can.
