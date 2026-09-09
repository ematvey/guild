// Transport + auth for the shared chat app.
//
// Two modes, same UI:
//  - Tauri (desktop): invoke/listen against the in-process engine; the
//    engine talks to the org gateway. Full agent features (project, tools).
//  - Web (served by guild-server at /): same-origin fetch/SSE against the
//    org gateway; plain chat. Auth is shared with the /admin console via
//    the same localStorage token.
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const TOKEN_KEY = "guild_token"; // shared with the admin console app

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

export async function getMessages(chatId: string): Promise<ChatMessage[]> {
  const token = getToken();
  const res = await fetch(`/api/v1/chats/${chatId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
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
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.id ?? null;
}

/// Streams one chat turn via the org gateway (web mode). Returns the final
/// done event, invoking onEvent for each frame (delta / tool_call / done / error).
export async function streamChat(
  chatId: string,
  model: string,
  prompt: string,
  onEvent: (ev: { type: string; content?: string; message?: string; tokens_in?: number; tokens_out?: number }) => void,
): Promise<void> {
  const token = getToken();
  const res = await fetch("/api/v1/gateway/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      chat_id: chatId,
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok || !res.body) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  const reader = res.body.getReader();
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
