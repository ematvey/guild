// Transport + auth for the shared chat app.
//
// Two modes, same UI:
//  - Tauri (desktop): invoke/listen against the in-process engine; the
//    engine talks to the org gateway. Full agent features (project, tools).
//  - Web (served by guild-server at /): same-origin fetch/SSE against the
//    org gateway; plain chat.
//    the same localStorage token.
import { invoke } from "@tauri-apps/api/core";

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Base URL for server HTTP calls. Web: same-origin (guild-server serves the
/// app). Tauri: the webview origin is tauri://localhost, which the server
/// knows nothing about — same-origin fetches would die there — so they go to
/// the paired server URL the shell stored (afterAuth writes it from
/// session.info). Falls back to same-origin (""), e.g. pre-pairing.
export function serverBase(): string {
  if (IS_TAURI) {
    try {
      return (localStorage.getItem("guild.serverUrl") ?? "").replace(/\/$/, "");
    } catch {
      return "";
    }
  }
  return "";
}

/** Absolute URL for a server path ("/api/…"), base-aware. */
export function apiUrl(path: string): string {
  return `${serverBase()}${path}`;
}

export const TOKEN_KEY = "guild_token";
const CLIENT_ID_KEY = "guild_client_id";
const MACHINE_ID_KEY = "guild_machine_id";
let machineNameCache: string | null = null;

/** Stable machine identity (per app install): the executor key machine
 * tools are bound to. */
export function machineId(): string {
  let id = localStorage.getItem(MACHINE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(MACHINE_ID_KEY, id);
  }
  return id;
}

/** Human label of this machine (hostname via the engine). */
export async function machineName(): Promise<string> {
  if (machineNameCache) return machineNameCache;
  try {
    if (IS_TAURI) {
      const res = await invoke<any>("rpc_request", { method: "machine.info", params: {} });
      machineNameCache = res?.result?.name || machineId().slice(0, 8);
    } else {
      machineNameCache = machineId().slice(0, 8);
    }
  } catch {
    machineNameCache = machineId().slice(0, 8);
  }
  return machineNameCache ?? machineId().slice(0, 8);
}

/** Stable per-app-instance identity — the presence key for client-tool
 * termination detection (server resolves suspended client tools when the
 * app holding this id disconnects). */
export function clientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/** Holds one app-lifetime connection to /api/v1/events/stream (which also
 * registers this machine as a tool executor) and, in Tauri, keeps the
 * machine's liveness heartbeat running. Auto-reconnects on drop. Returns a
 * stop function. */
export function startEventStream(): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        let url = apiUrl(`/api/v1/events/stream?client_id=${encodeURIComponent(clientId())}`);
        if (IS_TAURI) {
          url += `&machine_id=${encodeURIComponent(machineId())}&machine_name=${encodeURIComponent(await machineName())}`;
        }
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${getToken()}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
        if (IS_TAURI && !heartbeat) {
          // Executor liveness: the server cannot detect a dead client from
          // an idle SSE stream, so the executor pings explicitly.
          heartbeat = setInterval(() => {
            void fetch(apiUrl("/api/v1/machines/heartbeat"), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${getToken()}`,
              },
              body: JSON.stringify({ machine_id: machineId() }),
            }).catch(() => {});
          }, 5000);
        }
        // drain; events are not consumed yet
        const reader = res.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        // fall through to reconnect
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
    if (heartbeat) clearInterval(heartbeat);
  };
} // shared with the settings window client code

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function apiLogin(
  url: string,
  email: string,
  password: string,
): Promise<{
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
}> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  setToken(v.token);
  return {
    email: v.user?.email ?? email,
    role: v.user?.role ?? "member",
    display_name: v.user?.display_name,
    avatar_url: v.user?.avatar_url,
  };
}

export async function apiMe(): Promise<{
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
} | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(apiUrl("/api/v1/auth/me"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  const v = await res.json().catch(() => ({}));
  return {
    email: v.email,
    role: v.role ?? "member",
    display_name: v.display_name ?? undefined,
    avatar_url: v.avatar_url ?? undefined,
  };
}

export async function listModels(): Promise<string[]> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/gateway/models"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.models ?? [];
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: string;
  machine_id?: string;
  machine_label?: string;
}

export interface MachineInfo {
  machine_id: string;
  name: string;
}

/** Connected machine executors for this account. */
export async function listMachines(): Promise<MachineInfo[]> {
  const res = await fetch(apiUrl("/api/v1/machines"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v?.machines ?? [];
}

/** Binds (machineId given) or unbinds (machineId null) a chat's machine. */
export async function bindChat(
  chatId: string,
  machineIdArg: string | null,
): Promise<ChatSummary | null> {
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/machine`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(machineIdArg ? { machine_id: machineIdArg } : { machine_id: "" }),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface ChatMessage {
  role: string;
  content: string;
  /// Present on assistant rows that requested tool calls.
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  /// Present on tool rows: the call this result answers.
  tool_call_id?: string;
}

export async function listChats(): Promise<ChatSummary[]> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/chats"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.chats ?? [];
}

export async function getMessages(
  chatId: string,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/messages`), {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.messages ?? [];
}

// ---- Thread events (shapes mirror crates/protocol/bindings/ThreadEvent.ts;
// the event log is the durable source of truth, message history and the
// rendered thread are both derivations of it) ----

export type UsagePayload = { tokens_in?: number; tokens_out?: number; cost_usd?: number };

export type ThreadBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string };

/** A file attached to a user turn (chip metadata; bytes via
 * /api/v1/attachments/{id}). `modality`: image | audio | video | document. */
export type MessageAttachmentMeta = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  modality: string;
};

export type ThreadEvent =
  | { type: "user_message"; content: string; attachments?: MessageAttachmentMeta[] }
  | { type: "system_message"; content: string }
  | {
      type: "assistant_message";
      turn: number;
      step: number;
      blocks: ThreadBlock[];
      usage: UsagePayload;
      model: string;
      /** Aborted mid-stream: blocks carry the delivered prefix only. */
      interrupted?: boolean | null;
    }
  | {
      type: "tool_result";
      turn: number;
      step: number;
      call_id: string;
      name: string;
      /** Model-facing text (what the model reads as the tool result). */
      content: string;
      is_error: boolean;
      /** Tool-private widget payload; opaque to the loop. */
      meta?: unknown | null;
    }
  | {
      type: "compaction";
      summary: string;
      /** Total tokens the pre-compaction history represented (informational). */
      tokens_before?: number | null;
      /** Message-bearing events immediately before this one kept verbatim in context. */
      keep_last?: number | null;
      /** Model + usage of the summarization call. */
      model?: string | null;
      usage?: UsagePayload | null;
    }
  | {
      type: "approval_request";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "approval_decision";
      call_id: string;
      approved: boolean;
      reason?: string | null;
    };

export interface ThreadEventRow {
  id: string;
  seq: number;
  event: ThreadEvent;
  created_at: string;
}

/// Context usage the server derives for a chat (task G1 contract): present
/// on the thread response only when the server reports it — absent on
/// pre-G1 servers, in which case the UI hides the gauge.
export interface ThreadContext {
  tokens: number;
  max: number;
  model: string | null;
}

export interface ThreadResult {
  events: ThreadEventRow[];
  context?: ThreadContext;
}

/** The durable thread: every persisted event for a chat, in write order. */
export async function getThread(
  chatId: string,
  signal?: AbortSignal,
): Promise<ThreadResult> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/thread`), {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return { events: [] };
  const v = await res.json().catch(() => ({}));
  return { events: v.events ?? [], context: v.context ?? undefined };
}

export async function createChat(title: string): Promise<string | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/chats"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(IS_TAURI ? { title, machine_id: machineId() } : { title }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.id ?? null;
}

/// Frame shape passed to stream consumers: loose — the server owns the
/// protocol (see crates/protocol/bindings/StreamEvent.ts); consumers
/// dispatch on `type` and read only the fields they know.
type StreamFrame = {
  type: string;
  content?: string;
  message?: string;
  tokens_in?: number;
  tokens_out?: number;
  // tool frames
  call_id?: string;
  name?: string;
  arguments?: string;
  executor?: string;
  is_error?: boolean;
  // approval frames
  approved?: boolean;
  reason?: string;
};

/// Reads an SSE response body, invoking onEvent for every data frame.
async function readSse(
  res: Response,
  onEvent: (ev: StreamFrame) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}

/** Uploads one file as a chat context attachment (POST raw bytes, metadata
 * in the query string per the server contract). */
export async function uploadAttachment(
  chatId: string,
  file: File,
): Promise<MessageAttachmentMeta> {
  const res = await fetch(
    `/api/v1/chats/${chatId}/attachments?filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || "application/octet-stream")}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${getToken()}` },
      body: file,
    },
  );
  if (!res.ok) throw new Error(`attachment upload failed: ${res.status}`);
  return (await res.json()) as MessageAttachmentMeta;
}

/** Fetches an attachment as a blob URL for thumbnails/downloads (authed). */
export async function attachmentBlobUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl(`/api/v1/attachments/${id}`), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/// Streams one chat turn via the org gateway (web mode). Returns the final
/// done event, invoking onEvent for each frame (delta / tool_call / done / error).
export async function streamChat(
  chatId: string,
  model: string,
  prompt: string,
  onEvent: (ev: StreamFrame) => void,
  signal?: AbortSignal,
  attachmentIds: string[] = [],
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/gateway/chat"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-guild-client-id": clientId(),
      ...(IS_TAURI ? { "x-guild-machine-id": machineId() } : {}),
    },
    body: JSON.stringify({
      chat_id: chatId,
      model,
      messages: [{ role: "user", content: prompt }],
      // only the desktop runtime can execute machine tools (read/bash/edit/
      // write); declaring them in the browser suspends the turn until the
      // 5-minute client-tool timeout
      client_tools: IS_TAURI,
      attachment_ids: attachmentIds,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  await readSse(res, onEvent);
}

/// Attaches to a generation that is running server-side for this chat
/// (e.g. one that outlived a disconnected client). The server ends the
/// stream immediately when nothing is in flight, so this always resolves
/// quickly either way.
export async function attachGeneration(
  chatId: string,
  onEvent: (ev: StreamFrame) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${chatId}/stream`), {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok || !res.body) return false;
  await readSse(res, onEvent);
  return true;
}

export interface PairingToken {
  id: string;
  secret: string;
  expires_at: string;
}

/// Issues a one-time pairing code for desktop enrollment. The full code is
/// composed client-side (`g1|<server_url>|<secret>`): the server URL is
/// routing info, the secret is the credential.
export async function createPairingToken(ttlMinutes = 30): Promise<PairingToken> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/auth/pairing-tokens"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ttl_minutes: ttlMinutes }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return { id: v.id, secret: v.secret, expires_at: v.expires_at };
}

export function pairingCode(serverUrl: string, secret: string): string {
  return `g1|${serverUrl.replace(/\/$/, "")}|${secret}`;
}

/// Delivers the result of a client-side tool call to the waiting chat
/// workflow. Late results (after the server timed the call out) are ignored.
/// `meta` is the tool's widget payload (spec C.2); the server persists it
/// verbatim on the tool_result event.
export async function postToolResult(
  chatId: string,
  callId: string,
  content: string,
  isError: boolean,
  meta?: unknown,
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${chatId}/tools/${callId}/result`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(
      meta === undefined
        ? { content, is_error: isError }
        : { content, is_error: isError, meta },
    ),
  });
  if (!res.ok) throw new Error(`tool result rejected (${res.status})`);
}

// ---- Usage (spec §4.5; charts) ----

export interface UsagePoint {
  bucket: string; // RFC 3339
  cost_usd: number;
}

/// Per-chat spend over time (chat-path usage events use session_id = chat
/// id). Empty points when the chat has no recorded spend.
export async function getChatUsage(chatId: string): Promise<{ points: UsagePoint[]; total: number }> {
  const token = getToken();
  const res = await fetch(
    `/api/v1/usage/series?group_by=none&bucket=day&chat_id=${encodeURIComponent(chatId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`usage series failed (${res.status})`);
  const v = await res.json().catch(() => ({}));
  const rows = (v?.rows ?? []) as UsagePoint[];
  return { points: rows, total: rows.reduce((s, r) => s + r.cost_usd, 0) };
}

// ---- Approvals (design spec 2026-09-12 sections D + F) ----

export type ApprovalPolicy = {
  default?: "ask" | "allow" | "never";
  overrides?: Record<string, "ask" | "allow" | "never">;
};

/// Delivers the user's decision on a pending tool approval. The first
/// decision wins server-side; late posts and replays are no-ops.
export async function postApproval(
  chatId: string,
  callId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${chatId}/approvals/${callId}`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(reason === undefined ? { approved } : { approved, reason }),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? `approval rejected (${res.status})`);
  }
}

/// Reads the signed-in user's approval policy (migration 0026: user-scoped,
/// applies to every chat they run); null = server default.
export async function getApproval(): Promise<ApprovalPolicy | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/me/approval"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
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
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
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

export interface Release {
  id: string;
  version: string;
  kind: string;
  platform: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export async function listReleases(): Promise<Release[]> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/releases"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.releases ?? [];
}

/// Mints a short-lived signed URL and triggers a browser download.
export async function downloadRelease(id: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/releases/${id}/download-url`), {
    headers: { authorization: `Bearer ${token}` },
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  const a = document.createElement("a");
  a.href = v.url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
