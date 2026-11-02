// The approval gate (approval_gate + exec_and_approval_gate onto the
// pi-durable tool-task hook):
//
// 1. Static exec policy (codex model) for command-bearing tools: a matched
//    `allow` rule skips the gate entirely; `forbidden` is a hard deny whose
//    text is the rule's justification; `prompt`/unmatched fall through.
// 2. The interactive approval gate behind it: the chat's approval mode
//    (composer selector) wins over the chat owner's account policy; the
//    unresolved default is the AI judge ("approve for me"). Never → denied
//    by policy; Ask → the gate.
// 3. The gate appends the ApprovalRequest thread event (the audit trail and
//    every attached client's pending card),
//    then suspends the tool task until the decision arrives on the approval
//    API (POST /api/v1/gateway/chat/{id}/approvals/{callId} → journaled
//    ApprovalDecision event) or the 5-minute timeout auto-denies. The
//    suspension is recoverable: a restart re-runs the gate, which finds the
//    recorded decision (echo semantics) or re-enters the wait.
//
// The batch contract (server-side workspace agent sessions) skips the
// interactive gate — trusted workspace, pre-approved — but the exec policy
// still applies.

import { hook, ToolTask } from "@earendil-works/pi-durable";
import type { HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { setTimeout as delay } from "node:timers/promises";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { codemodeScriptLint } from "./codemode-lint.js";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { ExecutorKind } from "../machines/dispatch.js";
import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import { taskAbortRequested } from "../storage/postgres/queries.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { approvalDecisionEvent, approvalRequestEvent, type JudgeVerdict } from "../platform/domain/thread-events.js";
import { uuidv5, uuidv7 } from "../platform/time.js";
import { evaluateExecute, type ExecPolicy } from "../execpolicy/matcher.js";
import type { IntegrationGate } from "./integrations.js";
import type { TraceStore } from "../platform/trace.js";
import { APPROVAL_POLICY_PROMPT_KEY, type OrgKvStore } from "../platform/store/org-kv.js";
import type { ChatStore } from "../platform/store/chats.js";
import { clientToolClass } from "../platform/domain/tool-class.js";

export { APPROVAL_POLICY_PROMPT_KEY };

/** Built-in "Approve for me" policy prompt (codex-style: only escalate
 *  potentially unsafe actions). Admin-tunable via the org KV key. */
export const DEFAULT_APPROVAL_POLICY_PROMPT =
  'You are the safety gate for an AI assistant that runs tools on the user\'s machine. You are given one proposed tool action as JSON. Decide whether it is safe to run automatically, without asking the user first.\n\nApprove routine, low-risk actions: reading files, ordinary read-only shell commands (ls, dir, cat, git status, git log, ping, date), writing or editing files inside the user\'s workspace, web searches, and fetching public URLs.\n\nAsk the user when the action is potentially unsafe: destructive or irreversible operations (deleting files or data, force-pushing, dropping or truncating databases, factory resets), anything touching files outside the workspace or system locations, installing or upgrading software, killing processes or services, sending credentials or secrets anywhere, spending money, sending messages or email on the user\'s behalf, or anything unusual for a coding assistant.\n\nReply with ONLY a JSON object, no other text: {"approve": true, "reason": "one short sentence"} where approve=true means run it silently and approve=false means the user must be asked first.';

const APPROVAL_POLICY_TIMEOUT_MS = 10_000;
const GATE_POLL_MS = 500;
const JUDGE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Pinned identities for judge trace rows without a resolvable chat owner
 *  (same pattern as the internal gateway key's synthetic ids). */
const INTERNAL_JUDGE_USER_UUID = uuidv5(JUDGE_NAMESPACE, "guild-llm-judge-user");
const INTERNAL_JUDGE_SESSION_UUID = uuidv5(JUDGE_NAMESPACE, "guild-llm-judge-session");

/** Server default approval policy for client tools (design §A): read-only
 *  tools flow, state-changing tools ask. */
export const SERVER_DEFAULT_POLICY = { default: "ask", overrides: { read_file: "allow" } };


export { canonicalJson } from "../platform/domain/json.js";
import { canonicalJson } from "../platform/domain/json.js";
import { AGENT_TOOL_NAMES } from "./agent-tools.js";

export interface ApprovalGateDeps {
  pool: PlatformPool;
  threads: ThreadStore;
  /** The chat's tenant and owner, its approval policy, and its open agent
   *  run (the judge trace's run id). */
  chats: Pick<ChatStore, "identityOf" | "approvalPolicyOf" | "openAgentRunOf">;
  /** The org's approval-policy prompt. */
  orgKv: Pick<OrgKvStore, "get">;
  log: Logger;
  execPolicy: ExecPolicy;
  approvalTimeoutMs: number;
  /** The loopback gateway base URL + internal key (the judge's model
   *  access — decision 7 metering). A missing internal key disables the
   *  judge: unresolved policies ask, the safe direction. */
  selfBaseUrl: string;
  internalKey: string | null;
  /** conversationId → chat id (the runtime's chat mapping). */
  chatOfConversation(conversationId: number): Promise<string | null>;
  /** Where this conversation's tools execute (drives the shell allowlist +
   *  the batch contract). */
  executorKind(conversationId: number): Promise<ExecutorKind>;
  /** The integrations chat runtime: the integration tool envelope —
   *  read-class tools and always_allow-curated tools flow; an `always_ask`
   *  curation forces the card, any other class follows the chat's approval
   *  mode (org governance wins in both directions). */
  integrations?: IntegrationGate;
  /** The conversation's configured model (the judge's route). */
  currentModel(conversationId: number): Promise<string | null>;
  /** The LLM trace sink: the judge self-reports its calls (caller='judge',
   *  verdict, cause carrying the tool call). A missing sink disables only
   *  the tracing, never the gate. */
  trace?: TraceStore | null;
  /** Server-side shell allowlist (GUILD_ALLOW_SHELL_TOOLS). */
  allowShellTools: boolean;
}

interface ChatPolicyRow {
  chat_mode: string | null;
  user_policy: Record<string, unknown> | null;
}

/** Effective policy for a user: the user's stored policy (migration 0026 —
 *  approval is user-scoped), or the server default when unset or unreadable
 *  (the safe direction). */
function resolvePolicy(stored: Record<string, unknown> | null): {
  default: string | null;
  overrides: Record<string, string>;
} {
  if (stored === null || typeof stored !== "object") {
    return SERVER_DEFAULT_POLICY as { default: string; overrides: Record<string, string> };
  }
  const overrides: Record<string, string> = {};
  const raw = stored["overrides"];
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") overrides[k] = v;
    }
  }
  const dflt = typeof stored["default"] === "string" ? stored["default"] : null;
  return { default: dflt, overrides };
}

function forTool(
  policy: { default: string | null; overrides: Record<string, string> },
  name: string,
): "allow" | "ask" | "never" {
  const override = policy.overrides[name];
  if (override === "allow" || override === "ask" || override === "never") return override;
  const dflt = policy.default;
  if (dflt === "allow" || dflt === "ask" || dflt === "never") return dflt;
  return "ask"; // safest
}

/** The AI judge: one short loopback gateway
 *  call, org-metered like any internal call. Any failure — route missing,
 *  quota, timeout, unparsable verdict — asks the user. Returns null as the
 *  approve field when the judge cannot decide (callers treat that as Ask).
 *  The full outcome (verdict, reason, latency) is logged and journaled on
 *  the approval request so cards explain why they asked. */
interface JudgeOutcome {
  approve: boolean | null;
  reason: string | null;
  ms: number;
}

async function judgeVerdict(
  deps: ApprovalGateDeps,
  orgId: string,
  chatId: string,
  userId: string | null,
  model: string,
  call: ToolCall,
): Promise<JudgeOutcome> {
  const startedAt = Date.now();
  const undecided: JudgeOutcome = { approve: null, reason: null, ms: 0 };
  if (deps.internalKey === null) return undecided;
  // The verdict actually returned — the finally's log reads this, not a
  // fresh-per-path object (an earlier log read a never-mutated original
  // and reported `null` for every verdict, hiding working approvals).
  let settled: JudgeOutcome | undefined;
  // Self-reported trace facts: the request id (also sent to the gateway so
  // its usage_events row joins), the response usage, and the failure text.
  const requestId = uuidv7();
  let usageIn = 0;
  let usageOut = 0;
  let finishReason = "";
  let errorTextTrace = "";
  let requestPayload: string | null = null;
  let responsePayload: string | null = null;
  let attempted = false;
  try {
    const prompt = (await deps.orgKv.get(orgId, APPROVAL_POLICY_PROMPT_KEY))?.trim() || DEFAULT_APPROVAL_POLICY_PROMPT;
    const action = canonicalJson({ tool: call.name, arguments: call.arguments });
    const body = {
      model,
      stream: false,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: action },
      ],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APPROVAL_POLICY_TIMEOUT_MS);
    timer.unref?.();
    let raw: string;
    try {
      attempted = true;
      requestPayload = JSON.stringify(body);
      const res = await fetch(`${deps.selfBaseUrl}/openai/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.internalKey}`,
          "x-guild-org-id": orgId,
          // The gateway records no llm_calls row for internal-caller
          // requests: the judge self-reports with the full outcome.
          "x-guild-internal-caller": "judge",
          "x-guild-request-id": requestId,
          ...(userId !== null ? { "x-guild-user-id": userId } : {}),
          "x-guild-chat-id": chatId,
          "x-guild-cause": `approval-gate:${call.name}:${call.id}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        deps.log.warn(
          { chatId, status: res.status, ms: Date.now() - startedAt },
          "approval judge: gateway rejected the call",
        );
        errorTextTrace = `gateway status ${res.status}`;
        settled = { ...undecided, ms: Date.now() - startedAt }; // quota/route failures ask the user
        return settled;
      }
      const rawBody = await res.text();
      responsePayload = rawBody;
      const parsed = JSON.parse(rawBody) as {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      usageIn = parsed.usage?.prompt_tokens ?? 0;
      usageOut = parsed.usage?.completion_tokens ?? 0;
      finishReason = parsed.choices?.[0]?.finish_reason ?? "";
      raw = parsed.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
    void chatId;
    const s = raw.trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b < a) {
      deps.log.warn(
        { chatId, ms: Date.now() - startedAt, raw: s.slice(0, 200) },
        "approval judge: no JSON in the verdict",
      );
      errorTextTrace = "no JSON in the verdict";
      settled = { ...undecided, ms: Date.now() - startedAt };
      return settled;
    }
    const verdict = JSON.parse(s.slice(a, b + 1)) as { approve?: unknown; reason?: unknown };
    if (typeof verdict.approve !== "boolean") {
      deps.log.warn({ chatId, ms: Date.now() - startedAt, raw: s.slice(0, 200) }, "approval judge: unparsable verdict");
      errorTextTrace = "unparsable verdict";
      settled = { ...undecided, ms: Date.now() - startedAt };
      return settled;
    }
    settled = {
      approve: verdict.approve,
      reason: typeof verdict.reason === "string" ? verdict.reason : null,
      ms: Date.now() - startedAt,
    };
    return settled;
  } catch (error) {
    deps.log.warn({ err: error }, "approval policy judge failed, asking the user");
    errorTextTrace = error instanceof Error ? error.message : String(error);
    settled = { ...undecided, ms: Date.now() - startedAt };
    return settled;
  } finally {
    const done = settled ?? undecided;
    if (done.ms > 0) {
      deps.log.info(
        { chatId, model, ms: done.ms, approve: done.approve, reason: done.reason },
        "approval judge verdict",
      );
    }
    // Self-report the call (caller='judge'): one row per attempted gateway
    // call — verdict, cause, usage, error text. Failures are logged and
    // dropped; the gate must never depend on the trace sink.
    if (attempted && deps.trace) {
      const sink = deps.trace;
      void (async () => {
        const runId = await deps.chats.openAgentRunOf(chatId).catch(() => null);
        await sink.record({
          ts: new Date(),
          request_id: requestId,
          org_id: orgId,
          user_id: userId ?? INTERNAL_JUDGE_USER_UUID,
          session_id: INTERNAL_JUDGE_SESSION_UUID,
          run_id: runId,
          chat_id: chatId,
          conversation_id: null,
          turn: null,
          caller: "judge",
          cause: `approval-gate:${call.name}:${call.id}`,
          model,
          provider: "gateway",
          tokens_in: usageIn,
          tokens_out: usageOut,
          reasoning_tokens: 0,
          cost_usd: 0,
          duration_ms: done.ms,
          finish_reason: finishReason,
          stream: false,
          error: errorTextTrace,
          verdict: done.approve,
          verdict_reason: done.reason ?? "",
          prompt_chars: requestPayload?.length ?? 0,
          completion_chars: responsePayload?.length ?? 0,
        });
        if (requestPayload !== null) {
          await sink.recordPayload(requestId, orgId, "request", requestPayload, runId ?? chatId);
        }
        if (responsePayload !== null) await sink.recordPayload(requestId, orgId, "response", responsePayload);
      })();
    }
  }
}

/** The chat's approval mode (composer selector) + the chat owner's account
 *  policy — one journaled row read; a read failure
 *  falls back to the server default (the safe direction). */
async function readChatPolicy(deps: ApprovalGateDeps, chatId: string): Promise<ChatPolicyRow> {
  try {
    return (await deps.chats.approvalPolicyOf(chatId)) ?? { chat_mode: null, user_policy: null };
  } catch (error) {
    deps.log.warn({ err: error, chatId }, "approval policy read failed, using server default");
    return { chat_mode: null, user_policy: null };
  }
}

/** The card this call already has on the journal, if any: the gate runs
 *  recoverably (pi-durable re-drives suspended tool tasks), and a re-run
 *  must reuse the shown card — never re-judge (a second metered call) or
 *  re-append. A live card never carries approve=true (that verdict runs
 *  the tool silently, before any card). */
async function existingApprovalRequest(
  deps: ApprovalGateDeps,
  chatId: string,
  callId: string,
): Promise<JudgeVerdict | undefined> {
  const raw = await deps.threads.approvalRequestJudge(chatId, callId);
  if (raw === null || raw === undefined) return undefined;
  const approve = raw["approve"];
  const reason = raw["reason"];
  const ms = raw["ms"];
  if (typeof approve !== "boolean") return undefined;
  return {
    approve,
    reason: typeof reason === "string" ? reason : undefined,
    ms: typeof ms === "number" ? ms : 0,
  };
}

/** The gate wait: returns `undefined` (approved → run the tool) or a block
 *  text (denied). The tool task suspends inside this hook until a decision
 *  event lands or the timeout lapses. */
async function waitForApproval(
  deps: ApprovalGateDeps,
  runtime: HookApi,
  chatId: string,
  call: ToolCall,
  context: Context,
  judge?: JudgeVerdict,
): Promise<{ block: string } | undefined> {
  const argsJson = canonicalJson(call.arguments);
  // Journaled request with a deterministic id: a recovery re-run of the gate
  // re-appends the same row (ON CONFLICT no-op), never a duplicate card.
  const requestId = uuidv5(JUDGE_NAMESPACE, `guild-approval-request:${chatId}:${call.id}`);
  const request = await deps.threads.appendEvent(
    chatId,
    approvalRequestEvent(call.id, call.name, argsJson, judge),
    requestId,
  );

  // Idempotent append returns the original card's time across reopen.
  const deadline = Date.parse(request.created_at) + deps.approvalTimeoutMs;
  try {
    while (true) {
      const decision = await deps.threads.latestApprovalDecision(chatId, call.id);
      if (decision !== null) {
        if (decision.approved) return undefined;
        return { block: decision.reason ? `denied by user: ${decision.reason}` : "denied by user" };
      }
      if (Date.now() >= deadline) {
        // The 5-minute auto-deny: journaled like a
        // decision, then the denied tool result. The text tells the model
        // the call is dead — a plain "denied" invites an immediate retry,
        // which gated again and burned another 5-minute cycle.
        const decisionId = uuidv5(JUDGE_NAMESPACE, `guild-approval-decision:${chatId}:${call.id}`);
        await deps.threads.appendEvent(
          chatId,
          approvalDecisionEvent(
            call.id,
            false,
            "approval timed out — the call was not run; do not retry it, continue without it or ask the user",
          ),
          decisionId,
        );
        return {
          block: "approval timed out — the call was not run; do not retry it, continue without it or ask the user",
        };
      }
      // Stop responsiveness: the stop path aborts the conversation's tasks;
      // an aborted run cancels this hook's context (the sleep rejects).
      await delay(GATE_POLL_MS, undefined, { signal: context.abortSignal });
    }
  } catch (error) {
    // Close/failure preserves pending work. Only persisted abort intent
    // represents a cancelled action; a transport/read error is no decision.
    const abortRequested = await taskAbortRequested(deps.pool, Number(runtime.taskId)).catch(() => null);
    if (abortRequested === true) {
      const decisionId = uuidv5(JUDGE_NAMESPACE, `guild-approval-decision:${chatId}:${call.id}`);
      await deps.threads
        .appendEvent(chatId, approvalDecisionEvent(call.id, false, "aborted before decision"), decisionId)
        .catch(() => {});
    }
    throw error;
  }
}

/** The beforeTool hook: exec policy → shell allowlist → approval policy →
 *  the interactive gate. */
export function createApprovalGate(deps: ApprovalGateDeps) {
  return hook(ToolTask, {
    async beforeTool(call: ToolCall, api, context) {
      const runtime = api;
      // The codemode wrapper call is not a capability — every nested call it
      // makes runs this gate on its own. Gating the wrapper too would ask
      // (a judge consult) before the script has even run, once per call.
      // But its script source gets the static check first: the known
      // doomed patterns (timers, busy-wait, tools.* globals, positional
      // args, Node-isms) fail here with a teaching message instead of
      // crashing — or worse, spinning — in the sandbox.
      if (call.name === CODEMODE_TOOL_NAME) {
        const code = call.arguments?.code;
        if (typeof code === "string") {
          const lint = codemodeScriptLint(code);
          if (lint !== undefined) return { block: lint };
        }
        return undefined;
      }
      const chatId = await deps.chatOfConversation(Number(runtime.conversationId));
      const isCommandTool = call.name === "bash" || call.name === "execute" || call.name === "agent_bash";
      // The agent's own sandbox tools act server-side even when the chat is
      // bound to a machine: same shell allowlist and same batch contract as
      // the server-side coding tools.
      const isAgentTool = (AGENT_TOOL_NAMES as readonly string[]).includes(call.name);
      // An unmapped conversation has no policy to consult, and failing open
      // here skipped the static deny rules, the shell allowlist and the card
      // for every tool. A command-bearing tool is refused instead; non-command
      // tools keep the batch contract below (pre-approved file operations).
      if (chatId === null) {
        return isCommandTool
          ? { block: "denied: this conversation has no approval mapping" }
          : undefined;
      }
      const executor = await deps.executorKind(Number(runtime.conversationId));
      const toolExecutor = isAgentTool ? "server" : executor;

      // 1. Static exec policy (the machine `execute` path's rules, applied
      //    to the harness's bash tool — same rules, same matcher).
      if (isCommandTool) {
        const decision = evaluateExecute(deps.execPolicy, call.arguments);
        if (decision.kind === "deny") {
          return { block: `denied by exec policy: ${decision.reason}` };
        }
        // Server-side executors honor the shell allowlist; machine-bound
        // chats run on the desktop's own executor.
        if (toolExecutor !== "machine" && !deps.allowShellTools) {
          return { block: "denied: shell tools are disabled on this server" };
        }
        if (decision.kind === "allow") return undefined; // static allow skips the gate
      }

      // 1b. Integration tools: the connector envelope. Guild-provided
      //     disclosure, read-class, and always_allow-curated tools flow;
      //     an always_ask curation forces the card; any other class falls
      //     through to the chat's approval mode below (full_access flows,
      //     ask/approve_for_me gate). The batch contract (server-side
      //     workspace sessions) skips the interactive gate like every
      //     server tool.
      if (deps.integrations !== undefined) {
        const decision = await deps.integrations.gateDecision(Number(runtime.conversationId), call.name);
        if (decision === "ask" && executor !== "server") {
          return waitForApproval(deps, runtime, chatId, call, context);
        }
        if (decision === "skip") return undefined;
        if (decision === "ask") return undefined;
        // "policy" and undefined fall through to the chat approval mode.
      }

      // 2. The batch contract: server-side workspace sessions are
      //    pre-approved — no interactive gate (the exec policy above still
      //    ran). Everything else gates by policy.
      if (toolExecutor === "server" && !isCommandTool) {
        // Non-shell server tools (read/write/edit) run under the same batch
        // contract.
        return undefined;
      }

      // 3. Approval policy: chat mode wins; unset resolves through the
      //    account policy or the AI judge.
      const chat = await deps.chats.identityOf(chatId);
      if (chat === null) return undefined;
      const orgId = chat.org_id;
      const chatOwnerId = chat.user_id;
      const { chat_mode, user_policy } = await readChatPolicy(deps, chatId);
      let decision: "allow" | "ask" | "never";
      if (chat_mode === "approve_for_me") {
        decision = "ask";
      } else if (chat_mode === "full_access" || chat_mode === "allow") {
        decision = "allow";
      } else if (chat_mode === "ask" || chat_mode === "never") {
        decision = "ask";
      } else if (user_policy !== null) {
        decision = forTool(resolvePolicy(user_policy), clientToolClass(call.name));
      } else {
        decision = "ask";
      }
      // The judge path (approve_for_me, or an unset account policy): a
      // routine action runs silently, anything flagged asks. A card this
      // call already has (a recovery re-run) short-circuits the judge.
      let judged: JudgeOutcome | null = null;
      if (chat_mode === "approve_for_me" || (chat_mode === null && user_policy === null)) {
        const existing = await existingApprovalRequest(deps, chatId, call.id);
        if (existing !== undefined) {
          judged = { approve: existing.approve, reason: existing.reason ?? null, ms: existing.ms ?? 0 };
        } else {
          const model = await deps.currentModel(Number(runtime.conversationId));
          if (model === null) {
            // A judge-less card is the symptom, never the cause: surface it.
            deps.log.warn({ chatId, callId: call.id }, "approval judge skipped: conversation has no model");
          }
          judged = model === null ? null : await judgeVerdict(deps, orgId, chatId, chatOwnerId, model, call);
          if (judged !== null && judged.approve === true) return undefined;
        }
      }
      if (decision === "never") return { block: "denied by policy" };
      if (decision === "allow") return undefined;

      // 4. Ask: the gate. A definite judge verdict rides the card so it can
      // show why it asked; an indecisive judge (null) is logged only.
      const judgeOnCard: JudgeVerdict | undefined =
        judged !== null && judged.approve !== null
          ? { approve: judged.approve, reason: judged.reason ?? undefined, ms: judged.ms }
          : undefined;
      return waitForApproval(deps, runtime, chatId, call, context, judgeOnCard);
    },
  });
}
