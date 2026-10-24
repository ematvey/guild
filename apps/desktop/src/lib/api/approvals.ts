// Approval policy and prompts (design spec 2026-09-12 sections D + F).

import { apiUrl, getToken } from "../session";

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
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/threads/${chatId}/approvals/${encodeURIComponent(callId)}`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(reason === undefined ? { approved } : { approved, reason }),
  });
  const v = (await res.json().catch(() => ({}))) as ApprovalPostResult;
  if (!res.ok) {
    throw new Error((v as { error?: { message?: string } })?.error?.message ?? `approval rejected (${res.status})`);
  }
  return v;
}

/// Per-chat approval mode (migration 0043, the composer's selector): the
/// chat's tool-approval default; null = the account-level policy applies.
export type ChatApprovalMode = "ask" | "approve_for_me" | "full_access";

export async function getApprovalPolicyPrompt(): Promise<{ prompt: string | null; default: string }> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/admin/approval-policy-prompt"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`approval policy prompt rejected (${res.status})`);
  const v = await res.json().catch(() => ({}));
  return { prompt: v.prompt ?? null, default: v.default ?? "" };
}

export async function setApprovalPolicyPrompt(prompt: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/admin/approval-policy-prompt"), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? `approval policy prompt rejected (${res.status})`);
  }
}

export async function getChatApproval(chatId: string): Promise<ChatApprovalMode | null> {
  try {
    const token = getToken();
    const res = await fetch(apiUrl(`/api/v1/threads/${chatId}/approval`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    const d = v?.default;
    return d === "ask" || d === "approve_for_me" || d === "full_access" ? d : null;
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


export async function setChatApproval(
  chatId: string,
  mode: ChatApprovalMode | "default",
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/threads/${chatId}/approval`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ default: mode }),
  });
  if (!res.ok) throw new Error(`approval mode rejected (${res.status})`);
}

/// Reads the signed-in user's approval policy (migration 0026: user-scoped,
/// applies to every chat they run); null = server default.
export async function getApproval(): Promise<ApprovalPolicy | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/me/approval"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`approval policy rejected (${res.status})`);
  const v = await res.json();
  return (v?.approval ?? v) as ApprovalPolicy | null;
}

/// Saves the user's approval policy (null resets to the server default).
/// Throws with the API's validation message on an invalid policy body.
export async function setApproval(policy: ApprovalPolicy | null): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/me/approval"), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: policy === null ? JSON.stringify({ approval: null }) : JSON.stringify(policy),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? `approval policy rejected (${res.status})`);
  }
}

/// Reads the org's admin-configured assistant system prompt; null = using the
/// built-in default ("You are a helpful assistant." + server-owned tool
/// instructions). Admin API.
export async function getAssistantPrompt(): Promise<string | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/admin/assistant-prompt"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`assistant prompt rejected (${res.status})`);
  const v = await res.json();
  return (v?.prompt ?? null) as string | null;
}

/// Saves the org's assistant system prompt (empty string resets to the
/// built-in default). Throws with the API's validation message on failure.
export async function setAssistantPrompt(prompt: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/admin/assistant-prompt"), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? `prompt rejected (${res.status})`);
  }
}

