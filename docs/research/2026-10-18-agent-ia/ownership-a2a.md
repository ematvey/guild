# Agent-to-agent communication and delegation — research for Guild

## 1. Mechanism comparison

| | Unit of work | Shared state | Identity | Loop control | User view |
|---|---|---|---|---|---|
| **A2A 1.0** | `Task` (stateful) + `Message` + `Artifact` | None; "opaque execution" is a goal | Agent Card declares schemes; credentials out-of-band | None in protocol | Client-side; task history, push notifications |
| **MCP** | Request/response call | None (stateless) | Server identity only | None | Host's business |
| **OpenAI Agents SDK** | Control transfer (handoff) or nested call (`as_tool`) | In-process history | None | Caller's logic | SDK trace |
| **LangGraph** | Node execution in a graph | Typed state + reducers, checkpointed | None | Graph edges, termination | Trace |
| **CrewAI** | Manager-assigned task | Crew task outputs | None | `max_iter`, `max_rpm`; delegation **off by default** | Verbose logs |
| **AutoGen** | Broadcast message in a group chat | Shared conversation | Named, no credentials | `MaxMessageTermination`; no consecutive speaker | Message stream |
| **OpenClaw** | Sub-agent **run** in its own session | Isolated; `context:"fork"` copies parent transcript | By `agentId`; lineage stamped at spawn | Depth 5, ≤5 children, ≤8 concurrent, leaf loses spawn tool | Nested under parent |

- **A2A** targets *independent, untrusted* agents across vendors. The card sits
  at `/.well-known/agent-card.json`; the spec says protect it with mTLS, network
  rules, or OAuth and use out-of-band credentials. `ListTasks` returns only
  tasks the caller may see. It is an interop protocol, not an orchestrator.
- **MCP** connects a model to tools, resources, prompts. No task lifecycle, no
  agent identity, no delegation. An agent behind MCP is just a tool.
- **OpenAI handoffs** are tools: `transfer_to_refund_agent`. The receiver
  inherits the conversation unless `input_filter` trims it. `Agent.as_tool()`
  is the other shape: a nested call that does not transfer the conversation.
- **LangGraph** has no agents talking. Nodes read and write one typed state
  object; a supervisor is a routing node; checkpoints make it replayable.
- **OpenClaw** is the closest match. A child runs in
  `agent:<id>:subagent:<uuid>`, isolated by default, and *announces* its result
  one level up; each level sees only its direct children. Children lose session
  and `message` tools, so they cannot talk to the user. Spawn writes
  `spawnedBy`, role, and scope into session metadata as host-owned provenance.
  Its team preset uses `allowAgents` plus `delegationMode:"prefer"` (prompt
  guidance, not a scheduler) and says specialists return artifacts "without
  delegating further".
- **Devin** has no agent-to-agent calls. Service users plus
  `create_as_user_id` attribute a session to a real person.
- **Slack / GitHub** stop loops at the platform: Slack marks integration posts
  with `subtype:"bot_message"` and `bot_id`; GitHub does not start a workflow
  for events caused by `GITHUB_TOKEN`.
- Letta's multi-agent docs returned 404, so Letta is not a source here.

## 2. Patterns

**Delegation** has two shapes. *Transfer*: the child takes over the
conversation (OpenAI handoff). *Call*: the child runs separately and returns a
value (A2A task, OpenClaw sub-agent, `as_tool`). Transfer is cheap and loses
attribution; call is auditable.

**Shared context.** A real shared store (LangGraph state, AutoGen group chat)
couples agents tightly and is hard to sandbox. Isolating systems (A2A, OpenClaw)
pass an explicit payload: task text, artifact refs, opt-in transcript fork.
Guild's rule that the workspace is the only shared state already matches that.

**Loop prevention** is never prompt-based. Every working system uses hard caps:
depth, children per parent, concurrency, timeout, and removal of the spawn tool
at the leaf. OpenClaw also strips messaging tools from children. AutoGen forbids
consecutive speakers; CrewAI ships delegation disabled.

**User visibility.** The parent stays the user's contact. Children appear nested
under the parent (OpenClaw's Subagents panel, view-only transcript), not as new
top-level chats.

**Audit.** Provenance is written by the host at spawn time, never by the model:
requester, spawning agent, role, scope, lineage. Devin does the same with
session attribution; A2A with per-task scoping.

## 3. Three architectures for Guild

**A. Delegated runs (OpenClaw model).** Agent calls
`delegate(agent, task, context)`. The server creates a child **run** with
`parent_run_id`, target agent, depth, own sandbox and workspace. The child
returns a result plus artifact paths.
- Pros: reuses `agent_runs`, the activity log, and per-agent sandboxes. No new
  transport. Attribution is free.
- Cons: no mid-run negotiation; cross-agent files need an explicit copy.

**B. Agent inbox / task bus (A2A-shaped).** Each agent has an addressable inbox;
`send_task(to, task)` creates a task row; the recipient runs on its own turn;
results return as messages. A thread can have several agent authors.
- Pros: async, multi-turn, survives restarts, maps to A2A later.
- Cons: needs a task state machine, loop guards, multi-author thread UI.
  Duplicates runs. Too much for M1.

**C. Shared workspace only.** Agents coordinate through files; a coordinator is
just a role in instructions. Nothing to build, but no addressing, attribution,
or result contract, and files race.

## 4. Recommendation

**M1: build A, and only A.**

- **Unit = run.** A delegation is a child row in `agent_runs` with
  `parent_run_id`, `delegate_agent_id`, `depth`, `requested_by_user_id`. No new
  protocol, no agent cards.
- **Addressing** = agent id in the org roster, resolved server-side. Agents are
  local and trusted; A2A earns its cost only across a trust boundary Guild does
  not have yet.
- **Context** = task text + artifact paths copied into the child's workspace
  under `inbox/<run-id>/` + optional parent-thread summary. Default isolated.
  Never share a live transcript.
- **Result** = text + artifact paths; parent gets a tool result (sync) or
  next-turn input (async). Link runs; do not merge transcripts.
- **Identity** = the child runs as the target agent, in its sandbox, with the
  *intersection* of the parent's effective tool policy and the target's policy.
  No credential passing. Record `spawned_by_agent` as host-owned provenance.
- **Loops** = depth cap 2, ≤3 children per run, no self-delegation, targets
  limited to an org allowlist, spawn tool removed at the cap, per-root-run token
  budget children decrement.
- **Visibility** = the parent thread shows one step, "delegated to *X*", linked
  to the child run URL. The child transcript is view-only and nested under the
  parent in Activity. Inbox gets an item only for a child approval or failure.

**Later:** multi-author agent threads (B) if users ask to watch two agents talk;
cross-agent routine chaining; an org agent registry; A2A only if external agents
appear.

## 5. Sources

- A2A spec 1.0.0 — https://a2a-protocol.org/latest/specification/
- A2A discovery / Agent Card — https://a2a-protocol.org/latest/topics/agent-discovery/
- A2A vs MCP — https://a2a-protocol.org/latest/topics/what-is-a2a/
- MCP architecture — https://modelcontextprotocol.io/docs/learn/architecture
- OpenAI Agents SDK handoffs — https://openai.github.io/openai-agents-python/handoffs/
- LangGraph graph API — https://docs.langchain.com/oss/python/langgraph/graph-api
- CrewAI hierarchical process — https://docs.crewai.com/learn/hierarchical-process
- AutoGen SelectorGroupChat — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
- OpenClaw sub-agents — https://docs.openclaw.ai/tools/subagents
- OpenClaw announce — https://docs.openclaw.ai/tools/subagents/announce
- OpenClaw nesting and auth — https://docs.openclaw.ai/tools/subagents/nesting
- OpenClaw multi-agent routing — https://docs.openclaw.ai/concepts/multi-agent
- Devin API — https://docs.devin.ai/api-reference/overview
- Slack message subtypes — https://docs.slack.dev/reference/events/message/
- GitHub recursive-trigger prevention — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
