// Transport + auth for the shared chat app.
//
// Two modes, same UI:
//  - Tauri (desktop): invoke/listen against the in-process engine; the
//    engine talks to the org gateway. Full agent features (project, tools).
//  - Web (served by guild-server at /): same-origin fetch/WebSocket against
//    the org gateway; plain chat.
//    the same localStorage token.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { WsServerMsg } from "../../../crates/protocol/bindings/Ws";
import { browserFs, daemonFs, prepareTurn as assembleTurn } from "./lib/context";
import type { Project } from "../../../crates/protocol/bindings/Project";
import type { CreateProjectRequest } from "../../../crates/protocol/bindings/CreateProjectRequest";

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

/** The real server origin ("https://guild.example"). Web: the page origin.
 * Tauri: the paired server URL — the webview origin (tauri.localhost) is not
 * a routable address, so codes built from it would be unusable. */
export function serverUrl(): string {
  return serverBase() || window.location.origin;
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
// Results drained by the poll loop before their caller's waiter was
// registered (a fast call completes in the engine while its submit ack is
// still in flight). Kept briefly so the registration can pick them up.
const rpcOrphans = new Map<number, { value: any; at: number }>();
const RPC_ORPHAN_TTL_MS = 10000;
let rpcPolling = false;

async function rpcPollLoop(): Promise<void> {
  while (rpcWaiters.size > 0) {
    try {
      const batch: any[] = await invoke<any[]>("rpc_poll");
      for (const v of batch) {
        const w = rpcWaiters.get(v?.id);
        if (w) {
          rpcWaiters.delete(v.id);
          rpcOrphans.delete(v.id);
          if (v?.error) w.reject(new Error(v.error?.message ?? String(v.error)));
          else w.resolve(v);
        } else {
          rpcOrphans.set(v.id, { value: v, at: Date.now() });
        }
      }
      const now = Date.now();
      for (const [id, orphan] of rpcOrphans) {
        if (now - orphan.at > RPC_ORPHAN_TTL_MS) rpcOrphans.delete(id);
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
    const orphan = rpcOrphans.get(id);
    if (orphan) {
      rpcOrphans.delete(id);
      const w = rpcWaiters.get(id);
      if (orphan.value?.error) {
        w?.reject(new Error(orphan.value.error?.message ?? String(orphan.value.error)));
      } else {
        w?.resolve(orphan.value);
      }
    }
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

export type MachinePresence = { connected: boolean; displaced?: boolean; auth_required?: boolean };

export async function watchMachinePresence(update: (presence: MachinePresence) => void): Promise<() => void> {
  const unlisten = await listen<MachinePresence>("app-presence", (event) => update(event.payload));
  const presence = await invoke<MachinePresence>("machine_presence");
  if (presence) update(presence);
  return unlisten;
}

export type ThreadState = {
  chat_id: string;
  seq: number;
  events: ThreadEventRow[];
  text: string;
  thinking: string;
  generating: boolean;
  /** The chat's project, for the sidebar's grouping. */
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
};

export interface SocketHandlers {
  onConnect?: () => void;
  onThreadState?: (state: ThreadState) => void;
  onThreadList: (chats: ChatSummary[]) => void;
  onChatStatus: (frame: { chat_id: string; generating: boolean }) => void;
  onFrame: (frame: { chat_id: string; machine_id: string | null; event: StreamFrame }) => void;
  onSync: (chat_id: string, phase: "begin" | "done") => void;
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

let refreshing: Promise<void> | null = null;
export function refreshSession(): Promise<void> {
  if (!refreshing) refreshing = (async () => {
    const response = await fetch(apiUrl("/api/v1/auth/refresh"), {
      method: "POST", headers: { authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401 || response.status === 403) throw new SessionExpiredError("Sign in again to reconnect");
    if (!response.ok) throw new Error("Session refresh is temporarily unavailable");
    const value = await response.json();
    if (typeof value.token === "string") setToken(value.token);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Mints a one-use ticket for a WebSocket upgrade. */
class SessionExpiredError extends Error {}
export async function mintTicket(refreshed = false): Promise<string> {
  const res = await fetch(apiUrl("/api/v1/ws/ticket"), {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (res.status === 401 && !refreshed) {
    await refreshSession();
    return mintTicket(true);
  }
  if (res.status === 401) throw new SessionExpiredError("Sign in again to reconnect");
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
    case "tool_dispatch":
      return;
    case "thread_state":
      handlers.onThreadState?.(message as unknown as ThreadState);
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
    case "live_frame":
      handlers.onFrame({ chat_id: message.chat_id, machine_id: message.machine_id ?? null, event: message.event as StreamFrame });
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
  let needsRefresh = false;
  const viewWatermarks = new Map<string, number>();

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
      if (needsRefresh) { await refreshSession(); needsRefresh = false; }
      const ticket = await mintTicket();
      if (stopped) return;
      const url = `${wsUrl()}/api/v1/ws?ticket=${encodeURIComponent(ticket)}&client_id=${encodeURIComponent(clientId())}`;
      const current = openSocket(url, factory);
      socket = current;
      current.onopen = () => {
        if (socket !== current || stopped) return;
        viewWatermarks.clear();
        opts.onConnect?.();
        sendSync();
      };
      current.onmessage = (event) => {
        if (socket !== current || stopped || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as WsServerMsg;
          if (message.type === "auth_required") {
            connecting = true;
            needsRefresh = true;
            current.close();
            void refreshSession().then(() => {
              needsRefresh = false;
              connecting = false;
              scheduleReconnect();
            }).catch((error) => {
              connecting = false;
              if (error instanceof SessionExpiredError) {
                stopped = true;
                opts.onAuthRequired?.();
              } else {
                opts.onError?.(error instanceof Error ? error.message : String(error));
                scheduleReconnect();
              }
            });
            return;
          }
          if (message.type === "thread_state") {
            if (message.seq <= (viewWatermarks.get(message.chat_id) ?? -1)) return;
            viewWatermarks.set(message.chat_id, message.seq);
          }
          routeMessage(message, opts);
        } catch {
          /* malformed server message — ignore */
        }
      };
      current.onerror = () => {
        current.close();
      };
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        scheduleReconnect();
      };
    } catch (error) {
      connecting = false;
      if (error instanceof SessionExpiredError) { stopped = true; opts.onAuthRequired?.(); return; }
      opts.onError?.(error instanceof Error ? error.message : String(error));
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
  try {
    const token = getToken();
    const res = await fetch(apiUrl("/api/v1/gateway/models"), {
      headers: { authorization: `Bearer ${token}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.models ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


export interface ApiKeyInfo {
  id: string;
  name: string;
  /** Key prefix (`gk_XXXXXX…`) — the only non-secret fragment on file. */
  prefix: string;
  created_at: string;
  revoked_at?: string | null;
}

/** This user's gateway API keys (Settings → API Keys). */
export async function listMyApiKeys(): Promise<ApiKeyInfo[] | null> {
  const res = await fetch(apiUrl("/api/v1/api-keys"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v?.keys ?? [];
}

/** Mints a key; the plaintext is shown exactly once, in the response. */
export async function createMyApiKey(
  name: string,
): Promise<{ key: ApiKeyInfo; plaintext: string } | null> {
  const res = await fetch(apiUrl("/api/v1/api-keys"), {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  if (!v?.plaintext || !v?.key) return null;
  return { key: v.key, plaintext: v.plaintext };
}

/** Revokes one of this user's keys. */
export async function revokeMyApiKey(id: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/api/v1/api-keys/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${getToken()}` },
  });
  return res.ok;
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
  /** The project (named workspace folder) the chat runs in; absent =
   * folderless. */
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
  /** Whether the bound machine's socket is live right now. */
  machine_online?: boolean;
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
  os?: string;
  os_version?: string;
  app_version?: string;
  last_ip?: string;
  first_connected_at: string;
  last_connected_at: string;
  last_seen_at: string;
  /** The machine's singleton socket is live right now. */
  connected: boolean;
}

/** Connected machine executors for this account. */
export async function listMachines(): Promise<MachineInfo[] | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/machines"), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v?.machines ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
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
  try {
    const token = getToken();
    const res = await fetch(apiUrl("/api/v1/chats"), {
      headers: { authorization: `Bearer ${token}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.chats ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


/// Lists the archived chats (the sidebar's Archived section). Null on
/// failure, same contract as `listChats`.
export async function listArchivedChats(): Promise<ChatSummary[] | null> {
  try {
    const token = getToken();
    const res = await fetch(apiUrl("/api/v1/chats?archived=1"), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.chats ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


/// Renames and/or archives a chat. Archived chats drop out of `listChats`
/// but direct links still resolve; `archived: false` unarchives.
export async function updateChat(
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<void> {
  const res = await fetch(apiUrl(`/api/v1/chats/${id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
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
      /** Spilled-result artifact this result points at (bytes via
       * /api/v1/tool_artifacts/{id}); the render card lives in `meta.card`.
       * Absent on inline results and old events. */
      artifact_id?: string | null;
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

export async function createChat(title: string, projectId?: string | null): Promise<string | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/chats"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, ...(projectId ? { project_id: projectId } : {}) }),
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

/** Fetches a spilled tool artifact as a blob URL for the download card
 * (authed, same mechanism as attachmentBlobUrl). */
export async function toolArtifactBlobUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl(`/api/v1/tool_artifacts/${id}`), {
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
/// resulting content. The JSON acknowledgment only confirms submission.
/// `sendMode` matters only while a turn is already generating: "queue"
/// (default) commits the message for the turn's next pause, "steer"
/// interrupts the in-flight turn and runs the message immediately.
export async function sendChatNoStream(
  chatId: string,
  model: string,
  prompt: string,
  attachmentIds: string[] = [],
  projectId?: string | null,
  messageId?: string,
  sendMode?: "queue" | "steer",
  skillsIndex?: string,
  projectInstructions?: string,
): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/v1/gateway/chat"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-guild-client-id": clientId(),
        ...(IS_TAURI ? { "x-guild-machine-id": machineId() } : {}),
      },
      body: JSON.stringify({
        chat_id: chatId,
        user_message_id: messageId,
        model,
        messages: [{ role: "user", content: prompt }],
        // Tools are declared for every client: desktop turns dispatch to the
        // bound machine, browser turns fall back to the server-side per-chat
        // sandbox (spec 2026-09-18 unification §4 phase 5b).
        client_tools: true,
        attachment_ids: attachmentIds,
        project_id: projectId || undefined,
        send_mode: sendMode,
        skills_index: skillsIndex || undefined,
        agents_md: projectInstructions || undefined,
      }),
      // A hung connection (proxy, tunnel, stalled body) must surface as an
      // error block. Delivery may already have committed; retries must reuse
      // the same user_message_id and immutable payload.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error("send timed out — delivery is unknown; retry this send to check or complete it");
    }
    throw e;
  }
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  const acknowledgment = await res.json();
  if (acknowledgment.accepted !== true) throw new Error("Chat command was not accepted");
}

/// Stops the chat's in-flight turn. The delivered prefix stays in history
/// (persisted as an interrupted assistant event). 409 (nothing generating)
/// resolves silently — the turn already ended.
export async function stopChat(chatId: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${encodeURIComponent(chatId)}/stop`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-guild-client-id": clientId(),
    },
  });
  if (res.status === 409) return;
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
}

/// Compacts the thread manually (the /compact composer command): one
/// summarization call replaces the pre-compaction history in the model's
/// view. Fire-and-forget — the compaction card lands via the thread sync.
export async function compactChat(chatId: string): Promise<void> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/gateway/chat/${encodeURIComponent(chatId)}/compact`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-guild-client-id": clientId(),
    },
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
}

/// Expands `/name` skill mentions in a turn prompt against the local skill
/// discovery, renders the skills index, and assembles the AGENTS.md
/// instructions (global config-dir file + the bound project's chain, Codex
/// semantics) — app-process RPC; browser mode has no local files and passes
/// the prompt through untouched.
export async function prepareTurn(
  prompt: string,
  projectDir?: string,
): Promise<{ prompt: string; index: string; instructions?: string }> {
  // Context assembly moved to the client (lib/context.ts) over the fs
  // bridge; browser mode has no local files and passes through untouched.
  const fs = IS_TAURI ? daemonFs(rpcCall) : browserFs;
  const scopes = await fs.scopes();
  return assembleTurn(fs, scopes, prompt, projectDir);
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

/// Chat project binding (replaces the removed per-chat folder): null
/// clears the chat's project.
export async function setChatProject(
  chatId: string,
  projectId: string | null,
): Promise<ChatSummary | null> {
  const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/project`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ---- Projects (spec §1/§2: a named folder bound to a machine) ----

export type { Project, CreateProjectRequest };

/** The signed-in user's projects (admin: all org projects). */
export async function listProjects(): Promise<Project[] | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/projects"), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.projects ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


/** Creates a project; throws with the API message (409 = name taken). */
export async function createProject(req: CreateProjectRequest): Promise<Project> {
  const res = await fetch(apiUrl("/api/v1/projects"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(req),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return v as Project;
}

/** Renames/re-binds a project (PUT /projects/{id}); no UI surface yet. */
export async function updateProject(
  id: string,
  patch: { name?: string; folder?: string; machine_id?: string; archived?: boolean },
): Promise<Project> {
  const res = await fetch(apiUrl(`/api/v1/projects/${id}`), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(patch),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return v as Project;
}

// ---- Folder sources (app-process commands; spec §5) ----

/** One WSL distro as a folder source. */
export interface Distro {
  name: string;
  running: boolean;
  pretty_name?: string | null;
}

/** One row of a directory listing. */
export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export async function listWslDistros(): Promise<Distro[]> {
  return invoke<Distro[]>("list_wsl_distros");
}

/** The distro's default user home (LINUX path, e.g. /home/me); null when
 * unavailable. Cached per boot in the app process. */
export async function wslHome(distro: string): Promise<string | null> {
  return invoke<string | null>("wsl_home", { distro });
}

/** The distro's PRETTY_NAME (e.g. Arch Linux); null when unknown. Fetched
 * on first browse (user-driven), cached per boot in the app process. */
export async function wslPrettyName(distro: string): Promise<string | null> {
  return invoke<string | null>("wsl_pretty_name", { distro });
}

/** Unfiltered directory listing (dotfiles included), dirs first. */
export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

/** A filesystem op on a REMOTE machine's executor socket, relayed by the
 * server (owner-scoped). `fs_list` → DirEntry[], `fs_home` → home path. */
export async function machineFsRequest(
  machineId: string,
  op: "fs_list" | "fs_home",
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(apiUrl(`/api/v1/machines/${machineId}/fs`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ op, payload }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? `machine request failed (${res.status})`);
  return (v as { result: unknown }).result;
}

/** Directory listing on a remote machine (dirs first, dotfiles included). */
export async function listRemoteDir(machineId: string, path: string): Promise<DirEntry[]> {
  const v = (await machineFsRequest(machineId, "fs_list", { path })) as { entries: DirEntry[] };
  return v.entries;
}

/** The remote machine's $HOME (LINUX path); null when unknown. */
export async function remoteHome(machineId: string): Promise<string | null> {
  const v = (await machineFsRequest(machineId, "fs_home")) as { home?: string };
  return v.home || null;
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
  try {
    const token = getToken();
    const res = await fetch(apiUrl(`/api/v1/chats/${chatId}/approval`), {
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
  // The server returns a root-relative signed path; in the Tauri webview a
  // relative href resolves against tauri://localhost and the download
  // fails. Resolve against the paired server (the page origin in the
  // browser).
  a.href = String(v.url).startsWith("/") ? `${serverUrl()}${v.url}` : v.url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
