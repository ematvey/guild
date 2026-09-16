// Transport + auth for the shared chat app.
//
// Two modes, same UI:
//  - Tauri (desktop): invoke/listen against the in-process engine; the
//    engine talks to the org gateway. Full agent features (project, tools).
//  - Web (served by guild-server at /): same-origin fetch/WebSocket against
//    the org gateway; plain chat.
//    the same localStorage token.
import { invoke } from "@tauri-apps/api/core";
import type { WsServerMsg } from "../../../crates/protocol/bindings/Ws";

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

/**
 * Poll-based rpc bridge: submit returns in <1ms; results are collected by a
 * single poll loop and routed to waiters by id. Long-lived invoke responses
 * (the old rpc_request shape) can be silently lost by Windows WebView2
 * deferral delivery — this never leaves an invoke open, so a slow or wedged
 * daemon surfaces as a caller-side timeout instead of an eternal spinner.
 * Resolves with the full JSON-RPC envelope (same shape rpc_request returned).
 */
const rpcWaiters = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
let rpcPolling = false;

async function rpcPollLoop(): Promise<void> {
  while (rpcWaiters.size > 0) {
    try {
      const batch: any[] = await invoke<any[]>("rpc_poll");
      for (const v of batch) {
        const w = rpcWaiters.get(v?.id);
        if (w) {
          rpcWaiters.delete(v.id);
          if (v?.error) w.reject(new Error(v.error?.message ?? String(v.error)));
          else w.resolve(v);
        }
      }
    } catch {
      // engine restarting — keep polling until the caller's timeout fires
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  rpcPolling = false;
}

export async function rpcCall(
  method: string,
  params: any,
  timeoutMs = 30000,
): Promise<any> {
  const id = await invoke<number>("rpc_submit", { method, params });
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(
        new Error(
          `${method} timed out after ${Math.round(timeoutMs / 1000)}s - the local Guild service did not answer. Quit every Guild process (incl. background ones) and reopen the app.`,
        ),
      );
    }, timeoutMs);
    rpcWaiters.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    if (!rpcPolling) {
      rpcPolling = true;
      rpcPollLoop();
    }
  });
}

/** Human label of this machine (hostname via the engine). */
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

export interface SocketLike {
  readonly readyState: number;
  onopen: ((event?: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event?: any) => void) | null;
  onclose: ((event?: any) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SocketHandlers {
  onThreadList: (chats: ChatSummary[]) => void;
  onChatStatus: (frame: { chat_id: string; generating: boolean }) => void;
  onFrame: (frame: { chat_id: string; machine_id: string | null; event: StreamFrame }) => void;
  onSync: (chat_id: string, phase: "begin" | "done") => void;
  onHistory?: (chat_id: string, events: ThreadEventRow[]) => void;
  onDisplaced?: () => void;
  onAuthRequired?: () => void;
  onError?: (message: string) => void;
  onOrgEvent?: (event: unknown) => void;
}

/** Converts the current HTTP origin into the WebSocket origin. */
export function wsUrl(): string {
  const base = serverBase();
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  }
  if (typeof window === "undefined") return "";
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

/** Mints a one-use ticket for a WebSocket upgrade. */
export async function mintTicket(): Promise<string> {
  const res = await fetch(apiUrl("/api/v1/ws/ticket"), {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}` },
  });
  const value = await res.json().catch(() => ({}));
  if (!res.ok || typeof value.ticket !== "string") {
    throw new Error(value?.error?.message ?? res.statusText);
  }
  return value.ticket;
}

/** Opens a WebSocket through the injectable browser socket factory. */
export function openSocket(url: string, factory: SocketFactory = (u) => new WebSocket(u)): SocketLike {
  return factory(url);
}

/** Pure protocol router. It has no browser or socket dependencies. */
export function routeMessage(message: WsServerMsg, handlers: SocketHandlers): void {
  switch (message.type) {
    case "hello":
      return;
    case "thread_list":
      handlers.onThreadList(message.chats as unknown as ChatSummary[]);
      return;
    case "chat_status":
      handlers.onChatStatus({ chat_id: message.chat_id, generating: message.generating });
      return;
    case "sync_begin":
      handlers.onSync(message.chat_id, "begin");
      return;
    case "history":
      handlers.onHistory?.(message.chat_id, message.events as unknown as ThreadEventRow[]);
      return;
    case "snapshot_frame":
    case "live_frame":
      handlers.onFrame({ chat_id: message.chat_id, machine_id: message.machine_id, event: message.event as StreamFrame });
      return;
    case "sync_done":
      handlers.onSync(message.chat_id, "done");
      return;
    case "displaced":
      handlers.onDisplaced?.();
      return;
    case "auth_required":
      handlers.onAuthRequired?.();
      return;
    case "error":
      handlers.onError?.(message.message);
      return;
    case "org_event":
      handlers.onOrgEvent?.(message.event);
      return;
  }
}

/** One member socket per tab or desktop webview. Reconnects always resync. */
export function startSocket(
  opts: SocketHandlers & {
    getOpenChatId: () => string | null;
    socketFactory?: SocketFactory;
  },
): { stop: () => void; resync: () => void } {
  const factory = opts.socketFactory ?? ((url: string) => openSocket(url));
  let socket: SocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connecting = false;

  const sendSync = () => {
    if (socket?.readyState !== 1) return;
    socket.send(JSON.stringify({ type: "sync", chat_id: opts.getOpenChatId() }));
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null || connecting) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  };
  const connect = async (): Promise<void> => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      const ticket = await mintTicket();
      if (stopped) return;
      const url = `${wsUrl()}/api/v1/ws?ticket=${encodeURIComponent(ticket)}&client_id=${encodeURIComponent(clientId())}`;
      const current = openSocket(url, factory);
      socket = current;
      current.onopen = () => {
        sendSync();
      };
      current.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          routeMessage(JSON.parse(event.data) as WsServerMsg, opts);
        } catch {
          /* malformed server message — ignore */
        }
      };
      current.onerror = () => {
        current.close();
      };
      current.onclose = () => {
        if (socket === current) socket = null;
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  void connect();
  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      current?.close();
    },
    resync: () => sendSync(),
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

export async function listModels(): Promise<string[] | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/gateway/models"), {
    headers: { authorization: `Bearer ${token}` },
  });
  // null = request failed (distinguishable from a legitimately empty list)
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.models ?? [];
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: string;
  machine_id?: string;
  machine_label?: string;
  /** A generation is in flight (sidebar spinner). */
  generating?: boolean;
  /** Unseen assistant turn (sidebar dot). */
  unread?: boolean;
}

/** Marks the chat read for the caller: the thread-list dot clears. */
export async function markChatRead(id: string): Promise<void> {
  const t = getToken();
  if (!t) return;
  try {
    await fetch(apiUrl(`/api/v1/chats/${encodeURIComponent(id)}/read`), {
      method: "POST",
      headers: { authorization: `Bearer ${t}` },
    });
  } catch {
    /* cosmetic — ignore */
  }
}

export interface MachineInfo {
  machine_id: string;
  name: string;
}

/** Connected machine executors for this account. */
export async function listMachines(): Promise<MachineInfo[] | null> {
  const res = await fetch(apiUrl("/api/v1/machines"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  // null = request failed (distinguishable from a legitimately empty list)
  if (!res.ok) return null;
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

export async function listChats(): Promise<ChatSummary[] | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/chats"), {
    headers: { authorization: `Bearer ${token}` },
  });
  // null = request failed (distinguishable from a legitimately empty list)
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.chats ?? [];
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
      /** Coarse tool category (web_search | web_browse | generic); absent on
       * pre-kind events. */
      kind?: "web_search" | "web_browse" | "generic" | null;
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
      /** Nobody was waiting when the decision landed; the call never ran. */
      expired?: boolean;
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
export type StreamFrame = {
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
  kind?: string;
  // approval frames
  approved?: boolean;
  reason?: string;
};

/** Uploads one file as a chat context attachment (POST raw bytes, metadata
 * in the query string per the server contract). */
export async function uploadAttachment(
  chatId: string,
  file: File,
): Promise<MessageAttachmentMeta> {
  const res = await fetch(
    apiUrl(`/api/v1/chats/${chatId}/attachments?filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || "application/octet-stream")}`),
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

/// Sends a chat command over HTTP. The member WebSocket delivers every
/// resulting frame; the response body is dropped unread.
export async function sendChatNoStream(
  chatId: string,
  model: string,
  prompt: string,
  attachmentIds: string[] = [],
  projectDir?: string | null,
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
      client_tools: IS_TAURI,
      attachment_ids: attachmentIds,
      project_dir: projectDir || undefined,
    }),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

/// In-flight mirror catch-up from the app process (single-process spec):
/// everything the fan-out bus delivered for this chat so far. `seq` is the
/// watermark — frames with seq ≤ it are already reflected in the frames.
export interface ChatSnapshot {
  running: boolean;
  seq: number;
  frames: StreamFrame[];
}

export async function chatSnapshot(chatId: string): Promise<ChatSnapshot> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("chat_snapshot", { chatId });
}

/// Pushes the run-in-folder state to the app process (tool execution lives
/// there now — including while the window is closed).
export async function pushChatDir(chatId: string, dir: string | null): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_chat_dir", { chatId, dir });
}

/// Hands the app process the machine identity (stable per install; keys the
/// chat bindings). Starts presence + tool dispatch.
export async function setMachineIdentity(machineId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_machine_identity", { machineId });
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
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${chatId}/approvals/${callId}`), {
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
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/approval`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  const d = v?.default;
  return d === "ask" || d === "approve_for_me" || d === "full_access" ? d : null;
}

export async function setChatApproval(
  chatId: string,
  mode: ChatApprovalMode | "default",
): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/approval`), {
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

export async function listReleases(): Promise<Release[] | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/releases"), {
    headers: { authorization: `Bearer ${token}` },
  });
  // null = request failed (distinguishable from a legitimately empty list)
  if (!res.ok) return null;
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
