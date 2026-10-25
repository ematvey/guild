lane:       srv-runtime
read:       39 files, none skipped
model:      7 concepts added, 19 attaches, 4 no_concept, 0 types_no_concept
gaps:       none added — the global translation-gap count stays at 30, all in other lanes
findings:   4 mechanical, 6 design
note:       check.py model reports two problems outside this lane: "outgoing-command"
            shares its canonical with itself (desktop), and an attaches entry names a
            missing file, apps/desktop/src/views/agents/worked-for-block.tsx.

---

FINDING:  The BIGINT-to-number parse rule is written twice, once per pool.
PATTERN:  duplicate
WHERE:    apps/server/src/importer/cli.ts:29-37 and apps/server/src/storage/postgres/pg.ts:7-12
COST:     A reader must learn two copies of one rule. The copy in cli.ts is
          pool-local. The copy in pg.ts is module-global. A change to one copy
          leaves the importer and the server with different id types.
OPTION A: Keep the pg.ts installer — delete the `types.getTypeParser` block in
          cli.ts and let the shared installer run. Breaks nothing: the importer
          builds a `pg.Pool` and the installer is idempotent. Effort: one edit.
OPTION B: Keep the cli.ts block — move the rule into a small module that both
          files call, and make pg.ts use it too. Breaks nothing. Effort: one
          new module plus two imports.
ASK:      Should one module own the BIGINT parse rule for every pool?

---

FINDING:  A guard in the inbox drain can never fire.
PATTERN:  dead-code
WHERE:    apps/server/src/harness/queue-recovery.ts:22 and apps/server/src/harness/queue-recovery.ts:28
COST:     The `writes` list holds only indexes whose `mode === "write"`. The
          loop then re-tests `item.mode !== "write"`. A reader must prove the
          guard is dead before trusting the loop.
OPTION A: Keep the loop shape — delete line 28. Breaks nothing. Effort: one
          line.
OPTION B: Keep the guard — build `writes` as a list of items, not indexes, so
          the mode test becomes meaningful. Breaks nothing. Effort: a small
          refactor of the loop.
ASK:      Is the mode test load-bearing for a future non-write index?

---

FINDING:  The worker wire form cannot carry `agentsMd`, but the worker passes it
          anyway.
PATTERN:  translation-gap
WHERE:    apps/server/src/worker/protocol.ts:32-40 and apps/server/src/harness/runtime.ts:114-135
COST:     `SubmitTurnInput` has `agentsMd`; `SubmitTurnWireInput` has no such
          field. worker/main.ts:129 passes the wire object straight into
          `submitTurn`, which expects the domain object. TypeScript accepts it
          because the extra field is optional. runtime.ts:1619 then reads
          `input.agentsMd`. The declared contract says the field cannot cross
          the fork; the runtime depends on it crossing.
OPTION A: Keep one shape — make `SubmitTurnWireInput` an alias of
          `SubmitTurnInput`, or add `agentsMd` to it. Breaks nothing at run
          time; the type starts telling the truth. Effort: one type edit.
OPTION B: Keep two shapes — add an explicit wire-to-domain mapper in
          worker/main.ts and list the dropped fields. Breaks nothing. Effort: a
          small function plus a test.
ASK:      Is the worker wire form a projection of the turn input, or the same
          object on another channel?

---

FINDING:  Two legacy compatibility branches run with no seam declaration.
PATTERN:  seam
WHERE:    apps/server/src/harness/integrations.ts:95 and apps/server/src/harness/integrations.ts:414
COST:     The `int_` tool-name prefix is accepted in three places: line 95
          strips it, lines 117-121 strip the slug namespace, line 414 lets it
          through the cheap gate. runtime.ts:708 also writes a
          `legacy_task_id` column. None of these carries an owner, a delete
          date, or a reason. A reader cannot tell which names still arrive.
OPTION A: Keep the tolerance — add `coherence:seam` markers with an owner and a
          date, and say which clients still send the prefix. Breaks nothing.
          Effort: three comments plus one decision.
OPTION B: Drop the tolerance — delete the prefix strip and the regex arm, and
          let old names fail closed. Breaks any client that still sends them.
          Effort: small code change plus a compatibility check.
ASK:      Does any shipped client still send the `int_` prefix?

---

FINDING:  The codemode rules live in two texts that already disagree.
PATTERN:  duplicate
WHERE:    apps/server/src/harness/extension.ts:31-40 and apps/server/src/harness/codemode-lint.ts:12-38
COST:     Both texts teach the same four rules: no timers, globals are not
          `tools.*`, one object argument, no Node or network. They list
          different globals. The lint names `models` (codemode-lint.ts:24); the
          prompt notes do not (extension.ts:33). runtime.ts:403-405 disables
          the `models` surface, so the lint teaches a name that does not exist.
          A reader must read both to learn the real rule set.
OPTION A: Keep the lint text — make the prompt section quote the lint messages,
          or derive both from one table. Breaks nothing. Effort: one shared
          table plus two readers.
OPTION B: Keep the prompt text — delete the `models` arm from the lint rule.
          Breaks nothing if the runtime keeps `models: false`. Effort: one
          regex edit.
ASK:      Is the lint the source of truth for codemode rules, or the prompt?

---

FINDING:  The coding-tool set is named in three places, and the prose lists two
          tools the constants do not.
PATTERN:  alias-collision
WHERE:    apps/server/src/harness/extension.ts:25 and apps/server/src/harness/integrations.ts:50
COST:     The prompt says the coding tools are `read`, `write`, `edit`, `list`,
          `bash` and `web_search` (extension.ts:25). `CODING_TOOL_NAMES` is
          `read`, `write`, `edit`, `bash` (integrations.ts:50).
          `AGENT_TOOL_NAMES` is `agent_read`, `agent_write`, `agent_edit`,
          `agent_bash` (agent-tools.ts:17). Three lists describe one surface.
          A reader cannot tell which tools an agent allowlist must name.
OPTION A: Keep the constants — build the prompt sentence from
          `CODING_TOOL_NAMES` and add `list`/`web_search` to it if they belong.
          Breaks nothing. Effort: one template plus a decision on the two
          extra tools.
OPTION B: Keep the prose — delete `CODING_TOOL_NAMES` and test the allowlist
          against the registry. Breaks the filter at runtime.ts:1233.
          Effort: a larger change.
ASK:      Are `list` and `web_search` part of the coding-tool set that an agent
          allowlist must name?

---

FINDING:  A durable conversation has no org, though every other record does.
PATTERN:  boundary
WHERE:    apps/server/src/harness/runtime.ts:1135 and apps/server/src/importer/importer.ts:123
COST:     The model defines `org` as the tenant that owns every record
          (server-core.json). Durable conversations are created `ownerless`
          (runtime.ts:742, runtime.ts:1129, importer.ts:123). `conversationForChat`
          takes `orgId` and discards it at runtime.ts:1135. The tenant is only
          on the `chats` row. A reader must learn that the durable journal sits
          outside the tenant model, and that a conversation cannot be scoped by
          org.
OPTION A: Keep ownerless conversations — delete the unused `orgId` parameter
          and state in the concept definition that the chat row owns the
          tenant. Breaks nothing. Effort: one signature plus its callers.
OPTION B: Keep the org on the conversation — create it with an owner and pass
          `orgId` through. Breaks the importer and every recovery path. Effort:
          large.
ASK:      Is the tenant of a durable conversation the chat row, or the
          conversation record itself?

---

FINDING:  The sandbox handle method list is kept in two copies.
PATTERN:  duplicate
WHERE:    apps/server/src/sandbox/protocol.ts:36-41 and apps/server/src/sandbox/env.ts:254-280
COST:     `HANDLE_METHODS` names the methods each handle kind accepts. The
          client proxy in env.ts hardcodes the same methods in a switch, with
          its own per-method `lost` kind. The plain-method list has the same
          split: protocol.ts:45-65 and env.ts:283-383. A new handle method must
          be added in both files or it fails at run time.
OPTION A: Keep the typed proxy — add a test that walks `HANDLE_METHODS` and
          asserts the proxy has each method. Breaks nothing. Effort: one test.
OPTION B: Keep the wire tables — build the proxy from `HANDLE_METHODS` and drop
          the switch. Loses the typed interfaces. Effort: medium.
ASK:      Is the typed client proxy worth a second copy of the method list?

---

FINDING:  Three accessors and one raw map address the same chat-to-conversation
          mapping.
PATTERN:  no-home
WHERE:    apps/server/src/harness/runtime.ts:485 and apps/server/src/harness/runtime.ts:1868
COST:     `chatOfConversation` (line 485) scans the whole map per call.
          `conversationForChat` (line 1113) resolves, creates, deletes a stale
          row and attaches a watch. `conversationIdForChat` (line 1868) is a
          raw map read. The map itself is written in four places. A reader must
          learn which accessor is safe at which point in the lifecycle, and
          that one of them is O(n).
OPTION A: Keep three accessors — keep a reverse map so the lookup is O(1), and
          document which accessor may create. Breaks nothing. Effort: small.
OPTION B: Keep one accessor — route every caller through `conversationForChat`
          and delete the other two. Breaks callers that need a sync read.
          Effort: medium.
ASK:      Which accessor is the canonical read of the mapping?

---

FINDING:  Worker-mode machine dispatch is a second dispatch path with its own
          timeout and its own offline outcome.
PATTERN:  seam
WHERE:    apps/server/src/worker/dispatch-proxy.ts:15-22 and apps/server/src/worker/supervisor.ts:22
COST:     The direct path bounds a call with `timeoutMs`. The proxy adds a 30 s
          grace window (dispatch-proxy.ts:15) and answers with its own `OFFLINE`
          constant (lines 17-22) when the server is slow. The server side has
          its own 120 s request timeout (supervisor.ts:22). A reader must learn
          three deadlines to predict one outcome. No seam marker states which
          path is temporary.
OPTION A: Keep the proxy — declare the seam with an owner and a date, and
          derive the offline shape from the shared type. Breaks nothing.
          Effort: one comment plus one import.
OPTION B: Keep the direct path — move dispatch to a hub connection in the
          worker and delete the proxy. Breaks the current trust model. Effort:
          large.
ASK:      Is the IPC dispatch proxy permanent, or a step before workers hold a
          hub connection?
