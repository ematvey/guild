// Parse and serialize socket frames. The tag check plus a plain cast is
// enough: protocol/fixtures holds one example per variant, and the fixture
// test proves every shape. No validation library.

import type { ClientFrame, ServerFrame } from "./types.js";

// The tag lists are the runtime form of the frame unions. The type-level
// assertions below fail the build when a frame is added to a union and not
// to the list, or the other way round.
const SERVER_TAG_NAMES = [
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
  "model_list",
  "agent_list",
  "agent_run",
  "agent_threads",
  "agent_routines",
  "skill_catalog",
  "chat_tree",
] as const satisfies readonly ServerFrame["type"][];

const CLIENT_TAG_NAMES = [
  "ping",
  "sync",
  "read",
  "machine_response",
  "tool_result",
] as const satisfies readonly ClientFrame["type"][];

const _serverTagsExhaustive: Exclude<ServerFrame["type"], (typeof SERVER_TAG_NAMES)[number]> extends never
  ? true
  : never = true;
const _clientTagsExhaustive: Exclude<ClientFrame["type"], (typeof CLIENT_TAG_NAMES)[number]> extends never
  ? true
  : never = true;
void _serverTagsExhaustive;
void _clientTagsExhaustive;

const SERVER_TAGS: ReadonlySet<string> = new Set(SERVER_TAG_NAMES);
const CLIENT_TAGS: ReadonlySet<string> = new Set(CLIENT_TAG_NAMES);

/** Parse one frame text. Return the parsed object and its `type` tag, or
 *  null for bad JSON or a non-object. */
function frameOf(text: string): { raw: Record<string, unknown>; tag: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tag = (raw as Record<string, unknown>)["type"];
  return typeof tag === "string" ? { raw: raw as Record<string, unknown>, tag } : null;
}

/** Parse one server frame. Return null for bad JSON, a non-object, or an
 *  unknown `type` tag. */
export function parseServerFrame(text: string): ServerFrame | null {
  const frame = frameOf(text);
  if (frame === null || !SERVER_TAGS.has(frame.tag)) return null;
  return frame.raw as ServerFrame;
}

/** Parse one client frame. Return null for bad JSON, a non-object, or an
 *  unknown `type` tag. */
export function parseClientFrame(text: string): ClientFrame | null {
  const frame = frameOf(text);
  if (frame === null || !CLIENT_TAGS.has(frame.tag)) return null;
  return frame.raw as ClientFrame;
}

/** Serialize one client frame to a JSON text frame. */
export function serializeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
