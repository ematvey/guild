---
status: accepted
---

# Persistent coordination within the Agent runtime

This design specifies the accepted Agent harness variant and identifies implementation details that need concrete choices. The existing [domain model](../domain/001-domain.md) describes the running system; implementation changes update it alongside the code.

The harness separates responsive conversation and coordination from substantive work. It uses Guild's Agent, Thread, Input, Turn, Run, Workspace and Routine concepts. The personal Assistant is its first application; the mechanism also supports other configured Agents. Email screening is one personal Agent responsibility, supplied through configuration and an Integration.

## Design glossary

These terms describe roles and behavior within existing concepts. They do not establish new stored entities.

| Term | Meaning |
| --- | --- |
| Coordinator | The one persistent coordination role per Agent, receiving attributed inputs across Members and events, delegating work and deciding what deserves attention |
| Worker | A delegated execution role operating in a task Thread; a general worker uses the same Agent, while a predefined worker uses an accessible configured Agent |
| Responsibility | A standing instruction in the Agent Workspace defining an outcome or area of attention and its scope |
| Initiative | Choosing useful work within configured responsibilities and authority without a Member naming each task |
| Reflection | Background learning from activity and corrections that updates durable memory and working guidance |
| Compaction | Summarization of older conversation context while retaining recent context and stored history |
| Acting scope | An Agent-level choice of the access scope execution uses; external account identity and credential selection are separate design questions |
| Wake-up | A scheduled future Input to the persistent coordinator, carrying a reason and context; distinct from a Routine's isolated scheduled execution |

## Confirmed design

### Scope and execution roles

- Build a reusable harness primitive and apply it to each Member's personal Assistant. The Assistant occupies the first navigation entry.
- The coordinator handles conversation, memory and coordination. Its tools permit reading, writing and execution within its own Workspace, together with the coordination operations it needs. Integration calls and Machine execution belong to workers.
- Coordinator capabilities include Workspace access, subagent coordination, its own history and inspection of its Agent's Threads. It does not receive the substantive-work tools offered to workers, including read-only Integration tools or Machine execution. Workspace execution serves memory and coordination rather than substituting for worker execution.
- Tool provisioning enforces this role boundary; prompt guidance alone is insufficient.
- Dynamic general workers are the default. Accessible predefined Agents, including team- or org-published Agents, can also serve as workers.
- General workers are instances of the same Agent with separate Thread context and access to its writable Workspace. A different predefined Agent retains its own Workspace.
- Authorized delegation to a different predefined Agent uses that target Agent's own configured Integration grants, even when they differ from the delegating Agent's grants. General workers use the originating Agent's grants.

### Asynchronous coordination

- Maintain exactly one persistent coordinator conversation per Agent, shared across that Agent's Members and event sources. Coordinator Turns are short and process incoming Inputs; the coordinator is not a foreground job with a start/stop lifecycle.
- Spawning is asynchronous. A coordinator can finish its Turn while workers continue. Child results use Guild's existing delivery mechanism to wake an idle parent or enter an active Turn at a boundary.
- Members can converse directly with workers in their task Threads. The coordinator retains oversight through meaningful reports and can inspect details when needed.
- A coordinator can process background results silently. Reporting follows the Member's instructions: direct requests receive a response, and the coordinator confirms an ongoing job's reporting expectations.
- Minimize interruptions, user actions and message length. Substantial work or discussion takes place in a linked task Thread.
- Every worker Thread is inspectable under the Assistant's activity view. It enters the main chat list when the Assistant surfaces it or the Member opens it.
- Use the existing Routine scheduler and fresh hidden execution Thread per occurrence for scheduled work. Relevant findings can return to the coordinator. The result-delivery wiring remains to be designed.
- The coordinator can schedule its own future wake-up with a reason and relevant context. When due, that wake-up delivers an attributed Input to the persistent coordinator conversation and can start a Turn; it does not keep a Turn waiting or depend on a worker remaining alive.
- A coordinator self-wake is a scheduled Input, not a Routine. It is not represented or displayed as an ordinary Routine. Existing scheduler infrastructure can be reused where appropriate; its storage and direct-input delivery require design. Current reminders start isolated execution Threads and do not implement this behavior.
- An Agent can have multiple independent pending wake-ups. Scheduling one follow-up does not overwrite an unrelated follow-up. Wake-ups due together can be batched; exact batching and duplicate-scheduling rules remain open.

### Internal history and Member-facing Threads

- The Agent is the shared unit of context and knowledge. Messages from every Member feed its one coordinator history; its Workspace, memory, reflection and learned context are shared across those Members. User attribution identifies origin and reply routing, not a separate per-Member knowledge partition.
- The shared coordinator history is internal. Members see their own messages and what the coordinator explicitly sends to them, together with their authorized task conversations; they do not read the combined coordinator history.
- A personal Agent has the same architecture with one Member as its human source. A shared Agent receives attributed inputs from several Members.
- Ordinary Threads remain available. A Member can start a direct task conversation with an Agent independently of its persistent coordinator.
- User messages and final agent responses in those ordinary Threads are also appended to the Agent's coordinator history, with their source and causal references. These copies provide context without starting a coordinator Turn.
- Receiving an input and deciding whether it starts a Turn are separate operations. A coordinator-addressed request wakes coordination. A result from a worker started by the coordinator also wakes it, including when a Member is conversing directly with that worker. Messages and final replies in a Thread started independently by a Member are non-waking history inputs.
- Worker/task execution continues in its own Thread. The coordinator receives that context without relaying every exchange. Shared Agent knowledge and direct UI access to an originating Thread are distinct: the former is shared, while the latter follows the Member-facing visibility rule.
- Explicit outbound delivery chooses the recipient Member and destination Thread. Internal coordinator text does not automatically become a reply to the latest Member who spoke.
- The spawning relationship determines result delivery; opening or participating in a task Thread does not change it. Observation and delegated-result delivery must preserve one identifiable result without duplicate wake-ups; the deduplication mechanism remains open.

### Input provenance and causal links

- Every input presented to the coordinator carries a clear preamble identifying its source. A Member message includes the Member's name, ID and email, the originating Thread and a reference to the message.
- A worker report identifies the worker Agent and Thread, its Run/result, and the request or event that caused the delegation. When a Member originated the work, the report retains that Member and the originating Thread and message references.
- Event and Routine inputs identify their source and initiating event or occurrence. Their causal chain remains distinguishable from a direct Member message.
- References connect initiating inputs, delegated work and returned results even when unrelated messages and events intervene. The latest speaker is not an implicit recipient or originator for a delayed result.
- Identifier presentation remains open: compact aliases and UUIDs are both candidates. References must resolve unambiguously to durable records.
- Trusted metadata construction, reply routing, authority attribution and preservation of references during compaction require concrete design. A preamble does not by itself define access or grant authority.

### Acting scope

- Acting scope is configured on the Agent and applies to all its execution Threads, including independently Member-started Threads and coordinator-started workers.
- Shared/non-personal Agents default to Agent scope. Their setting can select Member scope instead.
- Personal Agents always use their owner's personal scope; their scope is not switchable to a shared Agent identity.
- A shared Agent has an access scope separate from the requesting Member's scope. Explicit Integration grants on the Agent define that scope, reusing the existing Integration list and per-Integration access ceilings. In Member scope, execution uses the originating Member's access scope.
- An Integration granted to an Agent defaults to read-only access. Write access requires an explicit per-Agent grant. The read-only default does not automatically grant the Agent access to unselected Integrations.
- External account identity and credentials are distinct from the access scope. Shared Agents cannot use account impersonation, including when configured for Member scope. They cannot impersonate a requester, the Agent owner or a dedicated account. Personal Agents retain their existing personal-account behavior.
- Integrations and operations that require account impersonation are unavailable to shared Agents. Other granted integrations use their supported existing credential mechanism; this design does not introduce per-Agent accounts.
- The originating user, message, Thread or event remains in the causal record regardless of acting scope. Source attribution and execution identity are separate facts.
- Attribution of usage, changes during active work, and scope across delegation to a different predefined Agent remain open implementation details.

### Unattended tool decisions

- Coordinator-managed work and Routines run unattended and do not request human tool approvals. They have no designated human approver or approval-recipient setting. Independently Member-started Threads retain their existing approval settings.
- Where an automatic judge evaluates an action, a rejection is returned to the executing agent as a rejected tool result. It does not create a human approval card or suspend for approval.
- The judge policy targets genuinely dangerous actions rather than broadly escalating mildly suspicious actions. Concrete criteria, examples and evaluation cases remain to be specified.
- Agent Integration grants and static execution prohibitions remain enforcement boundaries; a judge verdict does not expand those grants.
- A work-related question or decision can still reach a Member through normal conversation. That communication is distinct from a human tool-approval workflow.
- Opening or conversing in a coordinator-started worker Thread does not by itself change its unattended execution policy. Treatment of existing `always_ask` tool curation, cross-Agent delegation and policy changes during work requires explicit design.

### Initiative and capabilities

- Initiative supports discovering work within an agreed responsibility and broader opportunity discovery, configurable by scope.
- Standing responsibilities start as instructions in the Agent Workspace. Existing Routines hold scheduled work; this design does not introduce a separately managed responsibility-record subsystem.
- Authority, tool discovery and the currently loaded tool schemas are distinct. Integration-driven work must accommodate tools whose usefulness becomes clear during execution.
- General workers can discover and use any tool within the Agent's effective Integration grants as execution unfolds. The coordinator supplies the objective, constraints and optional starting hints, rather than an exhaustive tool subset. Discovery does not expand the Agent's grants or bypass execution policy and automatic judge decisions.
- Email monitoring and its cadence, draft/send rules and notification expectations are Agent configuration, not harness-specific behavior.

### Role models

- Coordinator, general worker, reflection and compaction roles have optional separate model settings. Each defaults to the Agent's model when no override is configured.
- A different predefined worker retains its own Agent configuration, including model settings.
- Role model selection is configuration, not permission for an arbitrary Thread to override its model. Exact settings representation and model-change behavior during active work remain open.

### Memory and reflection

- Use the existing Agent Workspace, including `MEMORY.md` and supporting notes, as the durable memory home.
- Same-Agent workers can write shared memory. Reflection consolidates and improves it rather than owning all writes.
- Reflection runs in the background, parallel to user requests and observed events. Foreground work does not wait for reflection.
- Reflection updates memory automatically. Its default triggers batch accumulated activity with a maximum delay and a compute budget; Agents can override defaults.
- Assessing whether a task succeeded and needs follow-up remains part of result handling. Cross-interaction learning belongs to background reflection.
- Concurrent editing must preserve newer writes. The reconciliation mechanism, update provenance and revision-history implementation remain open.

### Proactive compaction

- Reuse existing background compaction and token-size safeguards.
- Also trigger proactive compaction from accumulated activity, elapsed time and conversation milestones. Require enough new history and coalesce overlapping triggers.
- Summarization runs in parallel and applies at a safe Turn boundary while preserving subsequent Inputs.
- Reflection and compaction have separate purposes and can progress independently.
- Exact thresholds, summary contents and failure handling remain open. Compaction model selection follows the role-model configuration.

## Existing contracts and design consequences

| Existing contract or fact | Consequence for this design |
| --- | --- |
| Each Thread belongs to one Member; shared Agents share their Workspace, not their conversations | The shared internal coordinator requires an ownership and authority contract distinct from Member-facing Thread visibility; explicit deliveries reach only their intended recipients |
| Runs currently act for a Member, and impersonating Integration calls require a Member identity | Preserve source attribution and explicitly prevent shared Agents from using account impersonation; personal Agents retain existing behavior |
| An automatic judge rejection currently falls back to a human approval request | Unattended execution returns the rejection to the agent without creating an approval request; approval-mode and curation interactions need explicit handling |
| Members can read and cancel child Threads but cannot post into them | Direct Member conversation with workers requires a deliberate access-contract change |
| Spawning currently requires an explicit target Agent | Dynamic same-Agent workers need role-specific provisioning without accidentally granting coordinator restrictions to workers |
| The current Agent has one model and rejects per-Thread overrides | Optional per-role models require a deliberate configuration-contract change while keeping arbitrary Thread overrides separate |
| Child results are Turn ends submitted as parent Inputs | Use existing asynchronous delivery rather than a coordinator wait loop |
| A `write` Input records context without starting a Turn | Use this existing semantic for attributed observations of ordinary Thread messages and final replies; observation fan-out still needs wiring |
| Integration tools already support deferred disclosure and per-Integration `list_tools` | Extend existing discovery rather than add a second tool catalog |
| Each Routine occurrence already executes in a fresh hidden Thread | Reuse scheduling and define how findings reach coordination |
| Workspace conflict notices are best-effort warnings | They do not establish lost-update prevention for parallel memory writers |
| Visible state arrives through the member WebSocket and navigation has URLs | Activity, worker visibility and the Assistant entry require corresponding push and route contracts |
| Tree shape bounds delegation; explicit tree token/time budgets are rejected in the current domain model | Reflection's accepted compute budget needs precise scope and enforcement, without silently redefining tree limits |

Canonical references: [execution](../domain/003-execution.md), [access](../domain/002-access.md), [capabilities](../domain/004-capabilities.md), [live state](../domain/005-live-state.md).

## Known limitation

Shared Agents have no account-impersonation support. Integrations or operations requiring impersonation are unavailable to them, regardless of the requesting Member's access or the Agent's acting-scope setting. A future design must define account binding and authority before enabling that capability.

## Implementation decisions

Implementation resolves these details within the accepted design:

1. Judge danger criteria and unattended execution's interactions with existing tool curation, cross-Agent delegation and policy changes during work.
2. Acting-scope rules across delegation into a different predefined Agent and policy changes during active work, preserving the shared-Agent impersonation restriction.
3. Event delivery and scheduled coordinator Inputs, reusing timer infrastructure where suitable; storage, exact batching and duplicate-scheduling rules.
4. Trusted source preambles, durable causal references, and how direct Member messages and worker reports inform the coordinator without duplicate notifications.
5. Memory write reconciliation, provenance and concurrent reflection.
6. Reflection and compaction triggers, budgets and failure recovery; role-model settings representation.
7. Thread visibility and the Assistant navigation/Activity experience.
8. Evaluation scenarios and measurable responsiveness and interruption criteria.
9. Deduplication between passive observations and delegated results; explicit reply routing and causal attribution.

Backend, frontend, tests and browser verification establish the design's behavior. Review takes place through a pull request; merging is a separate release decision.

## Evidence

- [Tool-discovery research](../tool-discovery-research.md): retrieval must adapt as work unfolds; discovery is separate from authorization.
- [Memory research](../assistant-memory-research.md): same-Agent workspace access, background reflection and concurrency patterns.
- [Dot tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory.md): delegated tasks, separate task context, persistent notes and background research. Its internal scheduler and shared-memory implementation are not established by this documentation.
- [DeepSeek execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md): router, worker Sessions, asynchronous execution and per-ticket directories. The public prototype is distinct from the broader design essay.
