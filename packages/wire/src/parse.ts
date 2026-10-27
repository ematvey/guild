// Parse and serialize socket frames. The tag check plus a plain cast is
// enough: protocol/fixtures holds one example per variant, and the fixture
// test proves every shape. No validation library.

import type { ClientFrame, ServerFrame } from "./types.js";

const SERVER_TAGS: ReadonlySet<string> = new Set([
  "hello",
  "displaced",
  "auth_required",
  "tool_dispatch",
  "tool_cancel",
  "error",
  "machine_request",
  "thread_list",
  "chat_status",
  "thread_events",
  "sync_begin",
  "thread_state",
  "sync_done",
  "pong",
  "live_frame",
  "org_event",
  "subagent_tree",
  "machine_status",
  "archived_thread_list",
  "project_list",
  "machine_list",
  "workspace_identity",
]);

const CLIENT_TAGS: ReadonlySet<string> = new Set([
  "ping",
  "sync",
  "read",
  "machine_response",
  "tool_result",
]);

/** Read the `type` tag from parsed JSON. Return null for a non-object. */
function tagOf(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tag = (raw as Record<string, unknown>)["type"];
  return typeof tag === "string" ? tag : null;
}

/** Parse one server frame. Return null for bad JSON, a non-object, or an
 *  unknown `type` tag. */
export function parseServerFrame(text: string): ServerFrame | null {
  const tag = tagOf(text);
  if (tag === null || !SERVER_TAGS.has(tag)) return null;
  return JSON.parse(text) as ServerFrame;
}

/** Parse one client frame. Return null for bad JSON, a non-object, or an
 *  unknown `type` tag. */
export function parseClientFrame(text: string): ClientFrame | null {
  const tag = tagOf(text);
  if (tag === null || !CLIENT_TAGS.has(tag)) return null;
  return JSON.parse(text) as ClientFrame;
}

/** Serialize one client frame to a JSON text frame. */
export function serializeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
