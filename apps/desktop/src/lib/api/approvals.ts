// Approval policy and prompts (design spec 2026-09-12 sections D + F).

import { request } from "./request";

const threadPath = (chatId: string) => `/api/v1/threads/${encodeURIComponent(chatId)}`;

// ---- Approvals (design spec 2026-09-12 sections D + F) ----

export type ApprovalPolicy = {
  default?: "ask" | "allow" | "never";
  overrides?: Record<string, "ask" | "allow" | "never">;
};

/// Delivers the user's decision on a pending tool approval. The response
/// tells the caller how the card settles: `settled: true` with `approved`/
/// `expired` means a recorded decision was echoed (late clicks) or the call
/// was orphaned and journaled expired — settle the card from the response;
/// `settled: false` means a live turn took the decision and the
/// approval_resolved frame (or a reload) lands the pill.
export type ApprovalPostResult = {
  ok: boolean;
  settled?: boolean;
  approved?: boolean;
  reason?: string | null;
  expired?: boolean;
};

export async function postApproval(
  chatId: string,
  callId: string,
  approved: boolean,
  reason?: string,
): Promise<ApprovalPostResult> {
  const v = await request<ApprovalPostResult | undefined>(
    "POST",
    `${threadPath(chatId)}/approvals/${encodeURIComponent(callId)}`,
    reason === undefined ? { approved } : { approved, reason },
  );
  return v ?? { ok: true };
}

/// Per-chat approval mode (migration 0043, the composer's selector): the
/// chat's tool-approval default; null = the account-level policy applies.
export type ChatApprovalMode = "ask" | "approve_for_me" | "full_access";

export async function getApprovalPolicyPrompt(): Promise<{ prompt: string | null; default: string }> {
  const v = await request<{ prompt?: string | null; default?: string } | undefined>(
    "GET",
    "/api/v1/admin/approval-policy-prompt",
  );
  return { prompt: v?.prompt ?? null, default: v?.default ?? "" };
}

export async function setApprovalPolicyPrompt(prompt: string): Promise<void> {
  await request<unknown>("PUT", "/api/v1/admin/approval-policy-prompt", { prompt });
}

/** The chat's approval mode; null when the chat has none or it cannot be
 *  read. */
export async function getChatApproval(chatId: string): Promise<ChatApprovalMode | null> {
  try {
    const v = await request<{ default?: unknown } | undefined>("GET", `${threadPath(chatId)}/approval`);
    const d = v?.default;
    return d === "ask" || d === "approve_for_me" || d === "full_access" ? d : null;
  } catch {
    return null;
  }
}

export async function setChatApproval(
  chatId: string,
  mode: ChatApprovalMode | "default",
): Promise<void> {
  await request<unknown>("POST", `${threadPath(chatId)}/approval`, { default: mode });
}

/// Reads the signed-in user's approval policy (migration 0026: user-scoped,
/// applies to every chat they run); null = server default.
export async function getApproval(): Promise<ApprovalPolicy | null> {
  const v = await request<{ approval?: ApprovalPolicy | null } | ApprovalPolicy | null>("GET", "/api/v1/me/approval");
  return ((v as { approval?: ApprovalPolicy | null } | null)?.approval ?? v ?? null) as ApprovalPolicy | null;
}

/// Reads the org's admin-configured assistant system prompt and the
/// effective default the server uses when no override is stored. Admin API.
export interface AssistantPrompt {
  prompt: string | null;
  default: string;
}

export async function getAssistantPrompt(): Promise<AssistantPrompt | null> {
  const v = await request<{ prompt?: string | null; default?: string } | undefined>("GET", "/api/v1/admin/assistant-prompt");
  return { prompt: v?.prompt ?? null, default: v?.default ?? "" };
}

/// Saves the org's assistant system prompt (empty string resets to the
/// built-in default). Throws with the API's validation message on failure.
export async function setAssistantPrompt(prompt: string): Promise<void> {
  await request<unknown>("PUT", "/api/v1/admin/assistant-prompt", { prompt });
}
