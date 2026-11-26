// Chat reads and writes: the sidebar lists, the thread turns (send, stop,
// steer, withdraw, compact), attachments, and the chat's agent binding.

import { HAS_ENGINE } from "../session";
import { clientId, machineId } from "../machine-rpc";
import type { MessageAttachmentMeta } from "../thread-events";
import type { Chat, ChatTree, SubagentNode, ThreadType, UpdateChatRequest } from "@guild/wire/rest";
import { ApiError, request, requestResponse } from "./request";

const thread = (chatId: string) => `/api/v1/threads/${encodeURIComponent(chatId)}`;

/** The client identity header every turn command carries. */
const clientHeaders = (): Record<string, string> => ({ "x-guild-client-id": clientId() });

/** True for the 409 the server answers when a turn command lost its race
 *  (nothing generating, already placed). */
const conflict = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 409;

/** An authed binary read as a blob URL; null when it cannot be read. */
async function blobUrl(path: string): Promise<string | null> {
  try {
    const res = await requestResponse("GET", path);
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/** One sidebar row: the wire `Chat`. The wire omits `title` when the chat
 *  has none; render it with a fallback. */
export type ChatSummary = Chat;

/** The three kinds of thread. Archiving and deletion are flags, not types. */
export type { ThreadType };

/** One chat's place in the thread tree: its type, flags, run status, parent
 *  and origin. The member socket pushes it (`chat_tree`). */
export type { ChatTree };

/** One node of the chat's thread subtree, with its latest run status. */
export type ChatSubagentNode = SubagentNode;

/** The caller's active chats; null when the list cannot be read (distinct
 *  from a legitimately empty list). */
export async function listChats(): Promise<ChatSummary[] | null> {
  try {
    const v = await request<{ chats?: ChatSummary[] }>("GET", "/api/v1/threads");
    return v?.chats ?? [];
  } catch {
    return null;
  }
}

/// Renames and/or archives a chat. Archived chats drop out of `listChats`
/// but direct links still resolve; `archived: false` unarchives.
export async function updateChat(id: string, patch: UpdateChatRequest): Promise<void> {
  await request<unknown>("PATCH", thread(id), patch);
}

/** Soft-deletes a chat. The thread leaves every list; its transcript stays.
 *  Deletion is separate from archiving and cannot be undone in the app. */
export async function deleteChat(id: string): Promise<void> {
  await request<unknown>("DELETE", thread(id));
}

/** Creates a chat; null when the server refuses it. */
export async function createChat(title: string, projectId?: string | null): Promise<string | null> {
  try {
    const v = await request<{ id?: string }>("POST", "/api/v1/threads", {
      title,
      ...(projectId ? { project_id: projectId } : {}),
    });
    return v?.id ?? null;
  } catch {
    return null;
  }
}

export async function uploadAttachment(chatId: string, file: File): Promise<MessageAttachmentMeta> {
  const query = `filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || "application/octet-stream")}`;
  const res = await requestResponse("POST", `${thread(chatId)}/attachments?${query}`, { body: file });
  return (await res.json()) as MessageAttachmentMeta;
}

/** Fetches an attachment as a blob URL for thumbnails/downloads (authed). */
export function attachmentBlobUrl(id: string): Promise<string | null> {
  return blobUrl(`/api/v1/attachments/${encodeURIComponent(id)}`);
}

/** Fetches a spilled tool artifact as a blob URL for the download card
 * (authed, same mechanism as attachmentBlobUrl). */
export function toolArtifactBlobUrl(id: string): Promise<string | null> {
  return blobUrl(`/api/v1/tool_artifacts/${encodeURIComponent(id)}`);
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
  let acknowledgment: { accepted?: boolean } | undefined;
  try {
    acknowledgment = await request<{ accepted?: boolean }>(
      "POST",
      `${thread(chatId)}/turns`,
      {
        user_message_id: messageId,
        model,
        messages: [{ role: "user", content: prompt }],
        // Tools are declared for every client: desktop turns dispatch to the
        // bound machine, browser turns fall back to the server-side per-chat
        // sandbox.
        client_tools: true,
        attachment_ids: attachmentIds,
        project_id: projectId || undefined,
        agent_id: agentId || undefined,
        send_mode: sendMode,
        skills_index: skillsIndex || undefined,
        agents_md: projectInstructions || undefined,
      },
      {
        headers: { ...clientHeaders(), ...(HAS_ENGINE ? { "x-guild-machine-id": machineId() } : {}) },
        // A hung connection (proxy, tunnel, stalled body) must surface as an
        // error block. Delivery may already have committed; retries must
        // reuse the same user_message_id and immutable payload.
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new ApiError("timeout", "send timed out — delivery is unknown; retry this send to check or complete it", 0);
    }
    throw e;
  }
  if (acknowledgment?.accepted !== true) throw new ApiError("not_accepted", "Chat command was not accepted", 200);
}

/// Stops the chat's in-flight turn. The delivered prefix stays in history
/// (persisted as an interrupted assistant event). Resolves false on 409
/// (nothing generating — the turn already ended between the caller's
/// render and the click) so the caller lifts its optimistic stopping state
/// at once; true when the server accepted the stop.
export async function stopChat(chatId: string): Promise<boolean> {
  try {
    await request<unknown>("POST", `${thread(chatId)}/stop`, undefined, { headers: clientHeaders() });
    return true;
  } catch (e) {
    if (conflict(e)) return false;
    throw e;
  }
}

/** Promote the existing queued input; placement races preserve its identity. */
export async function steerQueued(chatId: string, messageId: string): Promise<"steering" | "pending" | "placed"> {
  try {
    await request<unknown>("POST", `${thread(chatId)}/pending/${encodeURIComponent(messageId)}/steer`, undefined, {
      headers: clientHeaders(),
    });
    return "steering";
  } catch (e) {
    if (conflict(e)) return e.code === "not_admitted" ? "pending" : "placed";
    throw e;
  }
}

/** Withdraws one queued (not yet placed) mid-turn send — the queued-chip
 *  trash button. False = it just got placed (409): refresh, the message is
 *  already transitioning to a delivered transcript bubble. */
export async function withdrawQueued(chatId: string, messageId: string): Promise<boolean> {
  try {
    await request<unknown>("DELETE", `${thread(chatId)}/pending/${encodeURIComponent(messageId)}`, undefined, {
      headers: clientHeaders(),
    });
    return true;
  } catch (e) {
    if (conflict(e)) return false;
    throw e;
  }
}

/** Starts a manual compaction. True when the server started a task; its
 *  outcome reaches the view as the durable compaction event in the thread
 *  state. False when there was nothing to compact. */
export async function compactChat(chatId: string): Promise<{ seq?: number } | null> {
  const started = await request<{ task_id: number | null; seq?: number }>(
    "POST",
    `${thread(chatId)}/compact`,
    undefined,
    {
      headers: clientHeaders(),
    },
  );
  if (started.task_id === null) return null;
  if (!Number.isSafeInteger(started.task_id) || started.task_id < 1) {
    throw new ApiError("invalid_response", "Invalid compaction task response", 200);
  }
  return typeof started.seq === "number" ? { seq: started.seq } : {};
}

/** The chat's agent and whether the picker may move it. A run transcript and
 *  a coordination thread keep their agent; an ordinary thread moves. */
export async function chatAgentBinding(chatId: string): Promise<{ agent: unknown | null; switcheable: boolean }> {
  try {
    const body = await request<{ agent?: unknown; switcheable?: boolean } | undefined>(
      "GET",
      `${thread(chatId)}/agent`,
    );
    return { agent: body?.agent ?? null, switcheable: body?.switcheable !== false };
  } catch {
    return { agent: null, switcheable: true };
  }
}

/** Binds a chat to an agent. A chat with a thread keeps its transcript.
 *  False when the server refuses the binding. */
export async function bindChatAgent(chatId: string, agentId: string): Promise<boolean> {
  try {
    await request<unknown>("POST", `${thread(chatId)}/agent`, { agent_id: agentId });
    return true;
  } catch {
    return false;
  }
}
