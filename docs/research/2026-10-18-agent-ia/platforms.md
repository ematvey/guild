# Agent platforms: runs, traces, activity UX

## 1. Activity model comparison

| Platform | Unit | Hierarchy | Naming | Error surfacing |
|---|---|---|---|---|
| **Letta** | message, grouped by `run_id` and `step_id` | agent → conversation → run → step (reasoning, tool call, tool result) | run/step IDs; ADE shows each message with its steps expanded inline | `is_err` on messages; `error` event then failed `result` with `errorCode` (`llm_api_error`, `max_steps`, `interrupted`, `stream_closed`) |
| **LangSmith** | run (= span) | project/agent → trace → run tree; threads group traces; trajectory flattens them | run name + run type (`llm`, `tool`, `chain`); trace = one turn | error flag on the run; red status in the tree; full inputs/outputs on the failing run |
| **Temporal** | workflow execution; event as atomic record | namespace → workflow ID → run ID (chain via retry/cron/continue-as-new) → event history | workflow type + workflow ID; run ID distinguishes attempts | status `Failed`/`Timed Out`/`Terminated`; task-failure saved view; failure detail inside event history |
| **Zep / Graphiti** | episode (raw ingested message, text, JSON) | user graph → thread/document → episode; derived facts/entities link back | episode UUID + source type; provenance, not a run name | episode `processed: false`, content-policy `failed`; extraction errors are not user-facing |
| **Inngest** | run; step inside it | app → function → run → step (with retries) | function ID + run ID; trigger event ID | failed run stores structured error on `output`; step timeline shows which retry failed |
| **Restate** | invocation (handler call) | service → handler invocation → journal entries | service/handler + invocation ID | terminal error vs retryable; journal replay shows the failed step |

The common shape is three levels: **container** (agent/project/function), **run** (one trigger-to-finish execution), **step** (one meaningful action). Traces are the developer view of the same data. Zep is the outlier: it logs *inputs and derived memory*, not executions, and uses provenance rather than status.

## 2. Developer trace UI vs user-facing activity feed

Developer UIs optimize for **causality and payloads**: nested spans, raw inputs/outputs, token counts, retries, replay, search by attribute (Temporal Visibility, Inngest CEL, LangSmith filters). They are dense, latency-oriented, and assume the reader knows the system. Errors are first-class rows.

User-facing feeds optimize for **"what happened while I was away"**: one line per run, plain-language outcome, time, and only the errors that need a decision. Detail is collapsed. LangSmith's own split is instructive: trace tree for debugging, trajectory (flat ordered messages) for reading what was exchanged, thread for the session story. Temporal's split is similar: list/visibility for finding, event history for proving.

Borrow from developers: stable run IDs, explicit terminal status, step timeline, structured error with the failing step, filters by status/time/agent. Borrow from consumer feeds: generated one-line summary, outcome-first ordering, silent runs still listed, no raw JSON unless expanded.

## 3. Three activity-feed UX patterns

**A. Dense run list (Temporal, Inngest).** Columns: time, agent, trigger, status, duration, summary. Best for scanning and filtering; supports "show only failures". Weak at narrative and at runs whose meaning is in the steps. Cost: needs a summary field, or rows read as machine output.

**B. Chronological timeline / feed (LangSmith thread, chat activity).** Grouped by day, cards in time order, each card expandable. Best for "what did my agent do today" and for mixing visible and silent runs. Weak when volume is high; failures scroll away; grouping by agent becomes hard.

**C. Per-run detail (drawer or page).** Header: agent, trigger, status, duration, one-line summary. Body: step timeline in user language ("Read inbox", "Drafted reply", "Sent message"), with technical spans collapsed underneath. Best for understanding and for errors. Cost: one click away, so it cannot be the only view.

Recommendation: A as the default surface, C as the drill-down, B as a per-agent "recent activity" strip. Never make the trace tree the primary view.

## 4. Recommendation for Guild

**Run record** (new table, one row per execution):
`id`, `agent_id`, `project_id`, `thread_id` (nullable), `routine_id` (nullable), `parent_run_id` (nullable), `trigger` (`message|routine|subagent|manual`), `status` (`queued|running|waiting_approval|succeeded|failed|cancelled|noop`), `started_at`, `ended_at`, `summary` (one generated line), `error_code`, `error_message`, `error_step_id`, `step_count`, `tool_call_count`, `tokens`, `visibility` (`visible|silent`), `notification` (`none|thread_created|message_sent`).

**Steps are not a new table.** Guild's `ThreadEvent` already carries `turn` and `step`; derive steps from events for the run's thread. Silent runs need a thread too, flagged hidden — this keeps one event model and makes the activity log the index over threads, not a parallel store. For runs with no thread, store a compact step list on the run.

**Activity view:** top-level Activity tab, list rows as in pattern A, filters for agent/project/status/time, default "all runs including silent", a "Needs attention" saved view for failures and pending approvals. Row click opens the run drawer (C). Thread view shows a small run summary card at the top of each turn, linking to the same drawer. Agent page shows the B strip. Projects group runs and threads by project, but a run always belongs to exactly one agent.

**Naming:** `<agent name> · <trigger> · <local time>`, with `summary` as the visible label. Silent runs get a "silent" chip and a summary such as "Checked inbox — nothing new". Do not hide them; do not notify.

**Errors:** the run record is the only required place. Write `error_code`/`error_message` there at failure, plus the failing step. Thread renders an error card only when the run was user-visible. Activity shows a red status and the message inline, so a silent failure is still discoverable.

**IA:** Agents → (Instructions, Routines, Threads, Runs, Files). Projects → (Threads, Runs). Global Activity = all runs. Threads are conversations; runs are executions; a run may create a thread. This keeps "chat" and "activity" from competing: the chat is the artifact, the run is the record of how it was made.

## 5. Sources

- https://docs.letta.com/v1-sdk/ade
- https://docs.letta.com/agent-sdk/sessions/index.md
- https://docs.letta.com/agent-sdk/messages/index.md
- https://docs.letta.com/api/resources/agents/subresources/messages/methods/list
- https://docs.langchain.com/langsmith/observability-concepts
- https://docs.langchain.com/langsmith/threads
- https://docs.temporal.io/workflow-execution
- https://docs.temporal.io/visibility
- https://docs.temporal.io/web-ui
- https://help.getzep.com/episodes
- https://help.getzep.com/concepts
- https://www.inngest.com/docs/platform-and-operations/inspect-events-and-runs
- https://www.inngest.com/docs/platform-and-operations/metrics
- https://docs.restate.dev/llms.txt
