// Thread event shapes and the two thread reads that do not ride the member
// socket: an older page of the durable log and the context-usage meter.
// Shapes mirror crates/protocol/bindings/ThreadEvent.ts, tightened for the
// client (the wire carries JsonValue).

import { apiUrl, getToken } from "./session";

export interface ThreadState {
  chat_id: string;
  seq: number;
  events: ThreadEventRow[];
  text: string;
  thinking: string;
  generating: boolean;
  /** An older page exists before `events[0]`. */
  has_more_events?: boolean;
  /** The chat's project, for the sidebar's grouping. */
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
};

export interface ThreadEventsPage {
  events: ThreadEventRow[];
  has_more: boolean;
}

/** One older page of a thread's durable log, for the scroll-to-top loader. */
export async function fetchThreadEventsPage(
  chatId: string,
  beforeSeq: number,
  limit: number,
  signal: AbortSignal,
): Promise<ThreadEventsPage> {
  const query = new URLSearchParams({ before: String(beforeSeq), limit: String(limit) });
  const response = await fetch(
    apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/events?${query}`),
    { headers: { authorization: `Bearer ${getToken()}` }, signal },
  );
  if (!response.ok) throw new Error("Could not load earlier messages");
  return response.json();
}

export interface ThreadContextUsage {
  tokens: number | null;
  max: number | null;
  model: string | null;
  usage_model: string | null;
  /** Display name of `usage_model`; null when that route is gone or unnamed. */
  usage_model_alias: string | null;
}

export async function fetchThreadContext(chatId: string, model: string, signal: AbortSignal): Promise<ThreadContextUsage> {
  const query = new URLSearchParams({ model });
  const response = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/context?${query}`), {
    headers: { authorization: `Bearer ${getToken()}` },
    signal,
  });
  if (!response.ok) throw new Error("Could not load context usage");
  return response.json();
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
  | {
      type: "user_message";
      content: string;
      attachments?: MessageAttachmentMeta[];
      /** Admitted while a turn was still generating: not yet seen by the
       *  model — rendered as a queued chip above the composer, not a
       *  transcript bubble, until the agent picks it up (the server moves
       *  the event and clears the flag at placement). */
      queued?: boolean;
      /** Requested placement for the same chip: "steer" joins the running
       *  turn at the next tool boundary; "queue" (and absent) runs as the
       *  next turn's input. */
      mode?: "steer" | "queue";
    }
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
      /** Failed provider attempt: the error text. Rendered only while this
       *  is the thread's latest block; a later retry supersedes it. */
      error?: string | null;
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
    }
  | { type: "turn_error"; message: string }
  | {
      type: "child_spawned";
      /** The child agent thread id. */
      thread_id: string;
      /** The child run id. */
      run_id: string;
      /** The durable chat id the child thread projects into. */
      chat_id: string;
      /** The child thread's agent name, for the row label. */
      agent_name: string;
      /** The child thread's title: the session name its spawner chose. */
      title: string;
      /** The request the parent sent to the child. Older events carry an
       *  empty string. */
      task: string;
      /** The child run's status at spawn time. */
      status: string;
    }
  | {
      type: "child_result";
      /** The child agent thread id. */
      thread_id: string;
      /** The durable chat id the child thread projects into. */
      chat_id?: string | null;
      /** The child thread's agent name, for the row label. */
      agent_name?: string | null;
      /** The child thread's title: the session name its spawner chose. */
      title?: string | null;
      run_id: string;
      /** The child run's terminal status; `cancelled` is a user stop. */
      status: string;
      reason?: string | null;
      /** The run's start (RFC3339): the elapsed anchor when no
       *  child_spawned row is loaded. */
      started_at?: string | null;
      final_text: string;
      attachments?: MessageAttachmentMeta[];
    }
  | {
      type: "child_closed";
      /** The child agent thread id the user closed. */
      thread_id: string;
    };

export interface ThreadEventRow {
  id: string;
  seq: number;
  event: ThreadEvent;
  created_at: string;
}

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

