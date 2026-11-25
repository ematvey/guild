# 003 Execution

This document follows work from an Input to a settled Run: the Turn and its Steps, where Tool calls run, the agent tree, Routines, and recovery. It builds on [001 Domain model](001-domain.md) and [002 Access](002-access.md).

## A Turn

### Submission

A Member's message carries a message id, and that id names the submission. A repeat with the same id and the same request returns the first result. A repeat with a different request is refused as `command_id_conflict`. The check runs before anything else, so a retried send never admits twice.

A Thread with no Agent is adopted by the sender's personal Agent here. The server then:

1. Marks the Thread `generating`.
2. Writes the Turn command.
3. Admits the Input.

The message's row is projected when its Input is placed, and the Turn that takes it opens its Run.

A failure before admission fails the command and recomputes `generating`.

### Admission and placement

Admissions are serialized per Thread. Admission provisions the Turn's Tools, stores the Project instructions, configures the Agent's model and submits the Input with the message id as its request id.

An Input is placed by its mode:

| Placement | When it reaches the model |
| --- | --- |
| steer | At the next tool boundary of the running Turn, joining it |
| followUp | After the running Turn ends, starting the next Turn (the default for a Member's message) |
| write | At once when the Thread is idle, else at the running Turn's next boundary, as a log entry: compaction summaries, posted agent messages, notices |

At a boundary every queued steer is taken together; follow-ups are taken one at a time. When a Thread has no running Turn, waiting Inputs are drained in order: writes first, then the steers and the first follow-up as one new Turn. Draining never invents an Input.

**The Thread's queue is the conversation's inbox, and nothing else.** Every waiting Input is its own item there (pi-durable's `submissions` rows and the `pi.inbox` document), never merged with another: a Member's message, a posted Turn, a child result, a write. Thread events record only what happened: a row exists once its Input is placed, projected from the entry, and a waiting Input has no row. The ThreadState frame carries the queue (`queue`), read from those tables, and the client renders it as chips.

A Member can act on a queued Input or a running Turn through Turn commands:

| Command | Effect |
| --- | --- |
| stop | Cancels pending admission, cancels child Runs and aborts the Turn at the next Step |
| steer | Moves a queued follow-up into the running Turn |
| withdraw | Removes a queued Input that is not yet placed |

A Turn command goes `pending` → `submitted` → `running` → `completed`, `failed` or `cancelled`. A pending command older than 15 minutes fails. A Member's message is a `guild.member-message` Input; its row (under the message id) is projected when it is placed. A message whose submit fails, or whose command expires, before the conversation admitted it loses its command, so a retry under the same message id starts over. One the conversation did admit stands.

A Turn that the system posts (a subagent `spawn` or `send`, a Routine prompt) is an Input of its own kind. Its message row is projected when the Input is placed, so a withdrawn one leaves nothing behind.

A **notice** tells a Thread's Agent about something that happened outside its Turns: a Member closed one of its child Threads, an ancestor sent a Turn to its child, or another Thread modified files this Thread is working on. It is a write whose text the Agent reads as a message. Its row (`child_closed`, `child_spawned`, or a log-only `system_message` for a file conflict) is projected from it.

### Steps and the end of a Turn

A Turn is one pi-durable run: a sequence of Steps. Each Step is one model call through the Org gateway, and its Tool calls run before the next Step. A steer taken at a tool boundary joins the Turn. The Turn ends after an assistant message that has no Tool call, or that has an error; Inputs still waiting then start the next Turn.

**A Run is the record of exactly one Turn.** It opens before the Turn's first model call, including one a restart resumes, so the call and its Tools see it. A delegated or Routine Turn creates its Run `queued` and submits its Input under the Run id as request id; the Turn that places that Input takes the Run over. Any other Turn opens a `message` Run for the Member who sent its message, else the Thread's owner. The Run settles once when the Turn ends, from the Turn's last answer, never earlier:

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

Attachments become part of the message, including when an inbox request becomes a coordinator Input. Document text is inlined, images go as image parts when the model accepts them, and other media get a note. The bytes are also materialized at `/tmp/attachments/<run>/`, for every Input the Turn takes: an Input placed mid-Turn (a steer, a child result) adds its files before the next Tool call. The `read` tool can open files in the current Run’s attachment directory. Parallel Turns keep separate directories. Starting a Turn or writing new attachments scans the next page of Run directories before writing files. Finished Runs’ directories can be reclaimed immediately. Directories without a saved Run are reclaimed after five minutes. Active Runs keep their files. `download` fetches any file of the Thread, and any file its child results carry, into a working folder at a path the call names; `send_file` takes a file of a working folder back into the Thread as an Attachment.

Compaction replaces the older context with a summary. It runs automatically, or on request, and its summary waits for the running Turn to end. Context usage is the token count of the last completed model call since the last compaction.

## Where Tool calls run

One default, for every Thread: a file tool without `machine` acts on the Agent's own Workspace, in its sandbox. A Project does not change that. The Thread's Machine is a fact the prompt states, not a target: to work on it the call names it.

| Tool | Without `machine` | With `machine` |
| --- | --- | --- |
| `read`, `write`, `edit`, `bash` | The Agent's Workspace, in the sandbox | That Machine, in `cwd` |
| `download` | Writes a file of the Thread into the Workspace | Writes it on that Machine |
| `send_file` | Reads a file of the Workspace into the Thread | Reads it from that Machine |

**A Machine named per call.** Every file tool takes `machine`: its id, or a label unique among the caller's Machines. The call then runs on that Machine instead of the sandbox, and `cwd` names the folder it runs in. Without `cwd` it runs in the Machine's home directory, read once and kept until the Machine goes offline, and no folder carries from one call to the next, so a command writes `cd <folder> && …`. A Machine the caller did not pair is not addressable, and `cwd` without `machine` is refused. The `machines` prompt section and the `machine_list` tool carry the same list: label, id and live flag.

**The target decides the card.** The Approval gate classifies a call by what it names: `machine` present means the call reaches the Member's own computer, and it takes a card; without `machine` the call stays inside the sandbox and takes the batch contract. Because the default really is the sandbox, the classification and the environment agree.

**Sandbox.** Each Agent sandbox mounts the same Agent Workspace read-write. A personal Agent has one gVisor sandbox. A non-personal Agent uses a separate sandbox for each Member's Threads and a separate sandbox for internal coordinator and reflection Threads. Scratch files live in each sandbox's own `/tmp`. With the Docker runner the personal Agent sandbox stays running and the idle reaper stops and removes non-personal Agent and plain chat sandboxes. With the Kubernetes Substrate adapter, each deployment attaches its Workspaces through its own CSI driver and selects its own Actor workers. Idle Actors suspend after the final connection closes and the next connection resumes them. An Actor's snapshot preserves scratch independently of the shared Workspace. Bytes leave the sandbox only as Attachments or Tool artifacts. The server reads the Workspace without following links, so a link planted inside the sandbox never resolves on the server.

**Machine.** A Tool call goes out on the Machine link as a dispatch and comes back as a result. If no live link holds the Machine, the call fails at once as `machine offline`. A result from a link that no longer holds the Machine is dropped. When a Machine reconnects, or its old link is unregistered, every call pending on the old link settles as "execution outcome is unknown; do not retry". The Agent must check before repeating anything outside the server.

**Large results.** A tool result over 64 KiB is saved as a Tool artifact. The Thread event shows a pointer to it, and the model's context keeps the whole result.

**Shared Workspace.** Turns of one Agent may run in parallel on its Workspace. Each Run records the paths it writes, keyed by the Machine the call ran on, so two Machines never collide on one path. When a Turn writes a path that another live Turn of the same Agent also wrote, the writer gets a warning on its tool result. The other Turn gets one system message if it started earlier. The Member is not told: the Agent resolves its own conflict.

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

**Downward messages are Turns. Upward messages are Turn ends.** When a child Run settles, its final text, its status and its Attachments are submitted to the parent's conversation as one child result. Nothing is submitted when the child or the parent is closed. The parent is then woken:

1. The result is a steer Input of its own, keyed by the child Run id, so a redelivery never admits it twice. A busy parent takes it into its running Turn at the next tool boundary; an idle one starts a Turn on it, which opens its own Run.
2. Results that are queued together are placed at the same boundary and reach the model in one call. A result never merges with another Input, so withdrawing a Member's message leaves it intact.
3. The parent Thread's child-result row is projected from the Input when it is placed. A result the parent has not received shows only in the queue.
4. A stop withdraws queued Inputs. A queued child result is then written into the conversation instead: the parent has it and the row shows, but no Turn starts.

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

A delivered message is an entry in the receiving Thread's conversation, written like a compaction summary: at once when the Thread is idle, else at the Turn's next boundary. The Agent reads it there as its own reply, it counts toward context usage, and compaction summarizes it. Every `send_message`, inside a Routine or not, lands this way. Each message also writes an `agent_message` Notice.

## Durability and recovery

**The journal is the truth.** Each Thread maps to one durable conversation, created once. Every Input, Step, Tool call and result is a journal entry before it has effects. Thread events are a projection of that journal: each entry is copied once, behind a stored cursor. **What a Thread shows as conversation, the Agent has in its conversation:** a message is written to the journal and projected; it is never appended to Thread events alone. Display-only rows (Approval cards, Turn failures) carry no message. A child-spawn row in the caller's own Thread shows the caller's `spawn` or `send` call. Clients cannot append Thread events. The Run and Turn command rows are reconciled from it the same way.

**Hosts reopen.** A conversation's host reopens after a failure with backoff (0, 1 s, 5 s, 30 s) and resumes. In worker mode, each active Thread has its own forked worker process. The supervisor respawns a dead worker only when the journal still holds pending work. It kills a worker that stops reporting its heartbeat for 90 seconds, or that ignores a stop for 10 seconds.

**Restart.** At start the server:

1. Repairs damaged projections.
2. Attaches only Threads that hold journal work, and resumes them.
3. Drains idle Inputs.
4. Recomputes `generating`.
5. Fails expired Turn commands.

A Turn cut off mid-Step resumes from its last recorded entry. A Tool call cut off on a Machine settles as unknown (see above).

**Orphans.** Every five minutes, a sweep fails Runs that are still queued or running, whose Thread has had no event for ten minutes and holds no journal work. Such a Run ends `failed` with `orphaned`. An orphaned child also delivers a failed result to its parent. A child Run that ended more than two minutes ago and whose result is in neither the parent's inbox nor its Thread is delivered again, rebuilt from the Run.

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

- The workspace change journal keys paths without their root, so one path written on a Machine and in the sandbox reads as one file.
- Event sources (webhooks, chat messages) cannot trigger a Routine yet; only time can.

## Coordinator execution

An Assistant inbox records a Member's message without running a model there. An atomic event capture creates a durable attributed coordination Input, delivered to the Agent's single internal coordinator. Inputs carry stable IDs, Member identity, source Thread/message references and causal origin. Ordinary independently started Threads continue running normally; their Member messages and final replies enter coordinator context passively without waking it.

The coordinator spawns workers asynchronously and ends its Turn without waiting. Existing child-result delivery wakes the parent; joining a worker Thread leaves that delivery active. Worker outcomes also become non-waking reflection records. Mutation identities include the durable tool task and nested call identity, making replies, worker creation, self-wakes and Routine creation replay safe. Coordinator capacity counts active and reserved workers rather than lifetime children.

Standing responsibilities live in Workspace instructions. Existing Routines execute scheduled work. Self-wakes are separate durable coordinator Inputs, with independent IDs, due times and cancellation; they create no Routine object. Reporting instructions determine whether background results need a Member reply. The coordinator queues a direct reply against the active Input. The first reply fixes its text and originating inbox. Delivery rechecks the Member’s access and retries interruptions with the same journal request ID. The Input records delivery or permanent failure and clears its queued text when settled. Later updates use explicit member-facing messages. Substantive work can be linked into its worker Thread.

Reflection runs on its own hidden Thread, parallel to foreground requests, after 20 unreflected Inputs or 30 minutes with pending activity by default. Each pass has a two-minute wall-time budget. Reflection reads the current Workspace `MEMORY.md` before editing it and uses supporting notes when needed. Successful passes mark only their captured Input IDs reflected. Failed passes retain them for retry. Reflected Input payloads expire after 30 days. Input references remain available for attribution and replay. One per-Agent database lock reserves reflection across processes. The coordinator and workers may also update memory directly.

Native file tools use normalized paths and a Workspace revision lock for protected memory files (`MEMORY.md`, `AGENTS.md`, `AGENTS.override.md`, `memories/`, `notes/`). Native edits require the revision this Thread last read and return a reconciliation error when the file has changed. The Turn loads `MEMORY.md` with the Workspace instructions. Shell calls follow the execution policy and contribute detected writes to the Workspace conflict journal.

Background compaction retains token-size safeguards and also starts after 60 new Inputs, or an hour with at least ten new Inputs. Thresholds are configurable in `resources.assistant`. The coordinator compaction prompt preserves source IDs, causal links, commitments, reporting preferences, pending workers and wake reasons. The durable conversation owns the compaction task and applies it at its safe boundary. The next activity count includes only placed Inputs outside the summarized prefix. A failed or empty compaction keeps those Inputs eligible. Automatic requests wait at least a minute after a finished attempt. Reflection and compaction are independent. Each role defaults to the Agent model and accepts an optional role model in the same settings object.
