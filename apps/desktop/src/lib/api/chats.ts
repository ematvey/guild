// Chat reads and writes: the sidebar lists, the thread turns (send, stop,
// steer, withdraw, compact), attachments, and the chat's agent binding.

import { IS_TAURI, apiUrl, getToken } from "../session";
import { clientId, machineId } from "../machine-rpc";
import type { MessageAttachmentMeta, StreamEvent } from "../thread-events";
import type { Chat, SubagentNode, ThreadType } from "@guild/wire/rest";

/** One sidebar row: the wire `Chat`. The wire omits `title` when the chat
 *  has none; render it with a fallback. */
export type ChatSummary = Chat;

/** The three kinds of thread. Archiving and deletion are flags, not types. */
export type { ThreadType };

/** One node of the thread tree: the open chat, its type, flags, status and
 *  parent. */
export interface ChatTree {
  chat_id: string;
  type: ThreadType;
  archived: boolean;
  deleted: boolean;
  title: string;
  agent_id: string | null;
  agent_name: string | null;
  status: string | null;
  depth: number;
  parent: { chat_id: string; title: string } | null;
  /** The run thread this one was opened from, when an agent delivered it. */
  origin: { chat_id: string; title: string } | null;
}

/** The open chat's position in the thread tree, for the child thread header. */
export async function fetchChatTree(chatId: string, signal: AbortSignal): Promise<ChatTree | null> {
  const response = await fetch(apiUrl(`/api/v1/chats/${encodeURIComponent(chatId)}/tree`), {
    headers: { authorization: `Bearer ${getToken()}` },
    signal,
  });
  if (!response.ok) return null;
  return response.json();
}

/** One node of the chat's thread subtree, with its latest run status. */
export type ChatSubagentNode = SubagentNode;

export async function listChats(): Promise<ChatSummary[] | null> {
  try {
    const token = getToken();
    const res = await fetch(apiUrl("/api/v1/threads"), {
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
    const res = await fetch(apiUrl("/api/v1/threads?archived=1"), {
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
  const res = await fetch(apiUrl(`/api/v1/threads/${id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
}

/** Soft-deletes a chat. The thread leaves every list; its transcript stays.
 *  Deletion is separate from archiving and cannot be undone in the app. */
export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/v1/threads/${id}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
}

export async function createChat(title: string, projectId?: string | null): Promise<string | null> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/threads"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, ...(projectId ? { project_id: projectId } : {}) }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v.id ?? null;
}

/// Frame shape passed to stream consumers: loose — the server owns the
/// protocol (see packages/wire/src/types.ts); consumers
/// dispatch on `type` and read only the fields they know.

export async function uploadAttachment(
  chatId: string,
  file: File,
): Promise<MessageAttachmentMeta> {
  const res = await fetch(
    apiUrl(`/api/v1/threads/${chatId}/attachments?filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || "application/octet-stream")}`),
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
  agentId?: string,
): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    // The thread API: the chat id rides the path (POST /api/v1/threads/:id/turns);
    // the old POST /api/v1/gateway/chat (chat_id in the body) is a deprecated
    // server alias.
    res = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/turns`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-guild-client-id": clientId(),
        ...(IS_TAURI ? { "x-guild-machine-id": machineId() } : {}),
      },
      body: JSON.stringify({
        user_message_id: messageId,
        model,
        messages: [{ role: "user", content: prompt }],
        // Tools are declared for every client: desktop turns dispatch to the
        // bound machine, browser turns fall back to the server-side per-chat
        // sandbox (spec 2026-09-18 unification §4 phase 5b).
        client_tools: true,
        attachment_ids: attachmentIds,
        project_id: projectId || undefined,
        agent_id: agentId || undefined,
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
/// (persisted as an interrupted assistant event). Resolves false on 409
/// (nothing generating — the turn already ended between the caller's
/// render and the click) so the caller lifts its optimistic stopping state
/// at once; true when the server accepted the stop.
export async function stopChat(chatId: string): Promise<boolean> {
  const token = getToken();
  const res = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/stop`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-guild-client-id": clientId(),
    },
  });
  if (res.status === 409) return false;
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  return true;
}

/** Promote the existing queued input; placement races preserve its identity. */
export async function steerQueued(chatId: string, messageId: string): Promise<"steering" | "pending" | "placed"> {
  const response = await fetch(
    apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/pending/${encodeURIComponent(messageId)}/steer`),
    {
      method: "POST",
      headers: { authorization: `Bearer ${getToken()}`, "x-guild-client-id": clientId() },
    },
  );
  if (response.status === 409) {
    const body = await response.json();
    return body?.error?.code === "not_admitted" ? "pending" : "placed";
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? response.statusText);
  }
  return "steering";
}

/** Withdraws one queued (not yet placed) mid-turn send — the queued-chip
 *  trash button. False = it just got placed (409): refresh, the message is
 *  already transitioning to a delivered transcript bubble. */
export async function withdrawQueued(chatId: string, messageId: string): Promise<boolean> {
  const token = getToken();
  const res = await fetch(
    apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/pending/${encodeURIComponent(messageId)}`),
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "x-guild-client-id": clientId(),
      },
    },
  );
  if (res.status === 409) return false;
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  return true;
}

/** Starts a manual compaction. True when the server started a task; its
 *  outcome reaches the view as the durable compaction event in the thread
 *  state. False when there was nothing to compact. */
export async function compactChat(chatId: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/compact`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "x-guild-client-id": clientId(),
    },
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(v?.error?.message ?? res.statusText);
  }
  const started = await res.json() as { task_id: number | null };
  if (started.task_id === null) return false;
  if (!Number.isSafeInteger(started.task_id) || started.task_id < 1) throw new Error("Invalid compaction task response");
  return true;
}

/// The org-skills HTTP surface lib/context's assembly consumes (spec §2.3):

export interface ChatSnapshot {
  running: boolean;
  seq: number;
  frames: StreamEvent[];
}



/** The chat's agent and whether the picker may move it. A thread belongs to
 *  its agent: shared agents and Main threads keep theirs. */
export async function chatAgentBinding(
  chatId: string,
): Promise<{ agent: unknown | null; switcheable: boolean }> {
  const res = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/agent`), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return { agent: null, switcheable: true };
  const body = (await res.json().catch(() => ({}))) as { agent?: unknown; switcheable?: boolean };
  return { agent: body.agent ?? null, switcheable: body.switcheable !== false };
}

/** Binds a chat to an agent. A chat with a thread keeps its transcript. */
export async function bindChatAgent(chatId: string, agentId: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/agent`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ agent_id: agentId }),
  });
  return res.ok;
}
