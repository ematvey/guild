// Transport + auth for the shared chat app.
//
// Two modes, same UI:
//  - Tauri (desktop): invoke/listen against the in-process engine; the
//    engine talks to the org gateway. Full agent features (project, tools).
//  - Web (served by guild-server at /): same-origin fetch/SSE against the
//    org gateway; plain chat. Auth is shared with the /admin console via
//    the same localStorage token.
import { invoke } from "@tauri-apps/api/core";

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
        let url = `/api/v1/events/stream?client_id=${encodeURIComponent(clientId())}`;
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
            void fetch("/api/v1/machines/heartbeat", {
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
} // shared with the admin console app

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
): Promise<{ email: string }> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  setToken(v.token);
  return { email: v.user?.email ?? email };
}

export async function apiMe(): Promise<{ email: string } | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch("/api/v1/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  const v = await res.json().catch(() => ({}));
  return { email: v.email };
}

export async function listModels(): Promise<string[]> {
  const token = getToken();
  const res = await fetch("/api/v1/gateway/models", {
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
  const res = await fetch("/api/v1/machines", {
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
  const res = await fetch(`/api/v1/chats/${chatId}/machine`, {
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
}

export async function listChats(): Promise<ChatSummary[]> {
  const token = getToken();
  const res = await fetch("/api/v1/chats", {
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
  const res = await fetch(`/api/v1/chats/${chatId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.messages ?? [];
}

export async function createChat(title: string): Promise<string | null> {
  const token = getToken();
  const res = await fetch("/api/v1/chats", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(IS_TAURI ? { title, machine_id: machineId() } : { title }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.id ?? null;
}

/// Reads an SSE response body, invoking onEvent for every data frame.
async function readSse(
  res: Response,
  onEvent: (ev: { type: string; content?: string; message?: string; tokens_in?: number; tokens_out?: number }) => void,
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

/// Streams one chat turn via the org gateway (web mode). Returns the final
/// done event, invoking onEvent for each frame (delta / tool_call / done / error).
export async function streamChat(
  chatId: string,
  model: string,
  prompt: string,
  onEvent: (ev: { type: string; content?: string; message?: string; tokens_in?: number; tokens_out?: number }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch("/api/v1/gateway/chat", {
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
  onEvent: (ev: { type: string; content?: string; message?: string; tokens_in?: number; tokens_out?: number }) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const token = getToken();
  const res = await fetch(`/api/v1/gateway/chat/${chatId}/stream`, {
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
  const res = await fetch("/api/v1/auth/pairing-tokens", {
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
export async function postToolResult(
  chatId: string,
  callId: string,
  content: string,
  isError: boolean,
): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/v1/gateway/chat/${chatId}/tools/${callId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, is_error: isError }),
  });
  if (!res.ok) throw new Error(`tool result rejected (${res.status})`);
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
  const res = await fetch("/api/v1/releases", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const v = await res.json().catch(() => ({}));
  return v.releases ?? [];
}

/// Mints a short-lived signed URL and triggers a browser download.
export async function downloadRelease(id: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/v1/releases/${id}/download-url`, {
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
