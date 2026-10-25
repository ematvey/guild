lane:       srv-domain
read:       29 files, all read in full (agents/, chats/, hub/ slices of apps/server/src)
model:      13 concepts added, 36 attaches, 0 no_concept, 0 types_no_concept
gaps:       none added (every new concept declares one role, so no conversion is owed)
findings:   6 mechanical, 5 design

Note on the gate: `check.py check` fails only on `loc 122389 -> 122428
(+39)`. I changed no source file. Other sessions are editing the tree.
`unmapped_files` fell 215 -> 45 from the parallel lanes, so `floor.json`
needs one `update` at merge time by whoever owns the floor.

```
FINDING:  The agent workspace path is built in five places, two of them with path.join and three with path.resolve
PATTERN:  duplicate
WHERE:    apps/server/src/agents/workspace.ts:26 and
          apps/server/src/agents/workspace-config.ts:27 and
          apps/server/src/agents/files.ts:87 and
          apps/server/src/agents/send-file.ts:91 and
          apps/server/src/agents/scheduler.ts:127
COST:     A reader must check five spellings before trusting that the browser,
          the purge sweep and the tool all point at the same directory. A
          change to the layout must find all five.
OPTION A: Keep `agentWorkspaceDir` in workspace-config.ts as the one home and
          make the other four call it. Mechanical, 5 small edits, no behaviour
          change. The roots differ (read-write, workspace, agentWorkspaceRoot),
          so the helper takes the root as an argument.
OPTION B: Keep `agentWorkspaceSubpath` in workspace.ts as the home and derive
          the host path at each call site. Cheaper to write, keeps five call
          sites.
ASK:      Which root is the authority for an agent workspace: the read-write
          volume or the workspace volume the sandbox sees?
```

```
FINDING:  Two encoders write the same ThreadState bytes and nothing keeps them equal
PATTERN:  duplicate
WHERE:    apps/server/src/chats/thread-state.ts:66 and
          apps/server/src/hub/protocol.ts:249
COST:     A new ThreadState field must be added twice, and a mistake shows up
          only as a frame mismatch between the sync bracket and the feed. The
          file comment already promises the two stay byte-identical, which is
          a promise no check enforces.
OPTION A: Keep `serializeServerMsg` as the one encoder. `threadStateWire`
          becomes `serializeServerMsg(threadStateMsg({ ...capture, seq: 0 }))`
          and the hand-built string goes. Mechanical, one function, the dedupe
          key is unchanged.
OPTION B: Keep both and add a test that compares the two outputs for one
          capture. Keeps the fast path, keeps the second copy.
ASK:      Is the hand-built string a measured cost, or a leftover?
```

```
FINDING:  The terminal assistant text of a run has two implementations with two different scans
PATTERN:  duplicate
WHERE:    apps/server/src/agents/lifecycle.ts:70 and
          apps/server/src/agents/delivery.ts:79
COST:     `terminalAssistantEvent` walks the turn's event list; `assistantTextForRun`
          re-queries thread_events and applies the same "no tool call" rule. A
          reader cannot tell which one the child result carries. Two more
          text extractors repeat the block walk: thread-read.ts:17 and
          store.ts:1026.
OPTION A: Keep lifecycle's rule as one exported helper that takes event rows,
          and let delivery.ts query rows and call it. Mechanical, 2 files.
OPTION B: Keep the delivery query and delete the lifecycle rule, moving the
          completion path onto the same query. Slower per completion.
ASK:      Does the child result text have to match the run summary text exactly?
```

```
FINDING:  Two different rules decide whether a path inside an agent workspace may be read
PATTERN:  boundary
WHERE:    apps/server/src/agents/files.ts:120 and
          apps/server/src/agents/send-file.ts:67
COST:     The browser refuses any path with a symlink segment
          (`assertNoSymlink` walks every segment). `send-file` follows the
          path, then checks the resolved real path and the final `lstat`. So a
          file behind an intermediate symlink is hidden in the UI and
          attachable by a tool. A reader must learn two security policies for
          one workspace.
OPTION A: Keep `files.ts` as the policy and export one resolver that both
          callers use. `send_file` loses the intermediate-symlink case; no
          agent can send such a file.
OPTION B: Keep `send-file.ts` (realpath containment, which is the stricter
          check for traversal) and relax `files.ts` to the same rule, so the
          browser lists what a tool can read.
ASK:      May a tool read a file that sits behind a symlink inside the agent
          workspace?
```

```
FINDING:  Agent delegation artifacts are still typed and routed, but migration 0088 dropped their table
PATTERN:  dead-code
WHERE:    apps/server/src/agents/types.ts:235 and
          apps/server/migrations/0088_agent_to_agent_backfill.sql:159
COST:     `AgentDelegationArtifact` and `AgentArtifactStatus` describe a table
          that no longer exists. `createArtifact` has no caller,
          `GET /api/v1/runs/:id/artifacts` (routes.ts:762) reads the dropped
          table, and the desktop API still declares `inbox_path` and
          `staging_path`. The real home for a child's transferred file is now
          `attachment`, so a reader learns two designs for one file.
OPTION A: Delete the two types, `createArtifact`, `listArtifacts`, the route
          and the desktop fields in one change. Mechanical, but it crosses
          three lanes, so it needs one owner.
OPTION B: Keep the route and return an empty list, with a comment naming
          `attachments` as the live home. Keeps the client contract, keeps the
          second design.
ASK:      Does any shipped client still call `/api/v1/runs/:id/artifacts`?
```

```
FINDING:  Two hub methods have no caller and one is a compatibility path with no seam marker
PATTERN:  dead-code
WHERE:    apps/server/src/hub/live.ts:90 and
          apps/server/src/hub/live.ts:339
COST:     `registerMachine` wraps `registerMachineInstance` "for callers that
          predate instance tracking", and no caller exists. `machineConnection`
          has no caller either. `machineBindable` and `machinesOfUser` are used
          only by tests. A reader must guess which of six machine accessors the
          live code uses.
OPTION A: Delete `registerMachine` and `machineConnection`. Mechanical, no
          behaviour change; the hub test keeps using the instance form.
OPTION B: Keep `registerMachine` and mark it
          `coherence:seam owner=... until=... reason="..."` so the debt has a
          date.
ASK:      Is a caller without instance tracking still expected?
```

```
FINDING:  MIME classification is kept in four tables with four different answers
PATTERN:  duplicate
WHERE:    apps/server/src/agents/send-file.ts:23 and
          apps/server/src/chats/turn-text.ts:20 and
          apps/server/src/chats/turn-text.ts:72 and
          apps/server/src/chats/spill.ts:40
COST:     `CONTENT_TYPES` maps an extension to a type, `modalityOf` maps a
          type to a modality, `attachmentIsTextual` maps type plus extension to
          a boolean, and `isTextMimeType` maps type to a boolean with a
          different list. The two textual tests disagree on
          `application/x-ndjson`, `application/csv` and every code extension.
          A reader must learn which one applies to inlining and which to spill.
OPTION A: Keep one module of mime knowledge: extension to type, type to
          modality, type to textual. The two call sites import it. Mechanical,
          but the lists must be merged by a human, because the wider list
          changes what gets inlined.
OPTION B: Keep both textual tests and write in each header which content it
          classifies. Cheap, keeps two answers.
ASK:      Is `application/csv` a document to inline, a text result to spill, or
          both?
```

```
FINDING:  "thread" names both a chat and an agent_threads row, and both ids ride one wire node
PATTERN:  alias-collision
WHERE:    crates/protocol/src/api.rs (Chat, alias "thread") and
          apps/server/src/agents/types.ts:107 (AgentThread) and
          apps/server/src/agents/tree.ts:10
COST:     The product calls a chat a thread (`/thread/<chat_id>`,
          tools.ts:91 says "One canonical address per thread: its chat"), while
          `agent_threads` is a separate row with its own id. `SubagentNode`
          carries `thread_id` and `chat_id` side by side, so every reader must
          hold both meanings at once.
OPTION A: Keep "thread" for the chat (it is the user's word and the URL) and
          rename the row to `agent-node` / `agent_node_id` across the server,
          routes and desktop. Large, touches the wire and the DB.
OPTION B: Keep `agent_threads` and stop calling a chat a thread in new code,
          starting with the two tool URLs. Small, leaves the existing names.
ASK:      Which word is the product word for a conversation: chat or thread?
```

```
FINDING:  Machine presence reaches the client by two paths: a direct push and a one-second poll
PATTERN:  duplicate
WHERE:    apps/server/src/hub/live.ts:154 (onMachineStatus -> feed.ts:455) and
          apps/server/src/hub/feed.ts:403 (watchPresence)
COST:     A slot claim sends `machine_status` at once, and the same flip also
          makes `watchPresence` re-send the whole `thread_list` on its next
          tick. A reader must decide which frame is the source of truth for the
          online dot, and the poll exists only because the push does not cover
          the list.
OPTION A: Keep the push and delete the presence poll: `machineStatus` also
          sends the owner's `thread_list`. Removes a 1 s timer per process and
          one duplicate path.
OPTION B: Keep the poll and drop `machine_status`, so the list is the only
          carrier. Slower dot, one path.
ASK:      Is the online dot allowed to lag one second behind the machine?
```

```
FINDING:  Two cursor designs mirror the durable log into platform tables
PATTERN:  boundary
WHERE:    apps/server/src/chats/projection.ts:39 and
          apps/server/src/chats/recovery.ts:8
COST:     `chat_projection_cursors` tracks entry_id, turn, step, run_open and
          the legacy boundary; `chat_reconciliation_cursors` tracks
          submission_id. Two classes, two tables, one job: "how far has this
          chat been copied". A reader must learn both to answer whether a
          restart can replay a chat.
OPTION A: Keep both and name the split in one comment each: entries feed the
          transcript, submissions feed the queue state. No code change.
OPTION B: Move both cursors behind one store interface so a reader has one
          entry point. Medium, touches the thread store.
ASK:      Can one restart path answer for both logs, or are they deliberately
          independent?
```

```
FINDING:  "workspace" means three things in one module: a sandbox target, a set of prompt files, and a per-turn write journal
PATTERN:  alias-collision
WHERE:    apps/server/src/agents/workspace.ts:49 and
          apps/server/src/agents/workspace-config.ts:1 and
          apps/server/src/agents/conflict.ts:1
COST:     `resolveConversationWorkspace` returns a sandbox key and host dir,
          `readAgentConfig` reads prompt files from the same directory, and
          `agent_workspace_turns` journals write paths in it. The three are
          related but not the same noun, and all three say "workspace".
OPTION A: Keep "workspace" for the directory and name the other two by what
          they are: `agent-config-files` and `workspace-write-journal`.
          Comment-only change in three files.
OPTION B: Keep the names and add one line to each header that says which
          workspace meaning it uses.
ASK:      Is the sandbox workspace and the prompt-file directory one thing that
          may split, or two things that happen to share a path today?
```
