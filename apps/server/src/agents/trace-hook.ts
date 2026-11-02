// Tool-call tracing: every tool call inside an agent run becomes a `tool`
// span in ClickHouse, linked to the run by the chat's running run id. The
// hook never blocks a call and never changes its result; a failed trace
// write is dropped like every other sink failure.

import {
  hook,
  ToolTask,
  type ConversationId,
  type HookRegistration,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { uuidv7 } from "../platform/time.js";
import type { TraceStore } from "../platform/trace.js";
import type { AgentStore } from "./store.js";

const MAX_TEXT = 4_000;

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  try {
    return JSON.stringify(value).slice(0, MAX_TEXT);
  } catch {
    return String(value).slice(0, MAX_TEXT);
  }
}

export function createTraceHook(
  trace: TraceStore,
  store: AgentStore,
  chatOfConversation: (conversationId: ConversationId) => Promise<string | null>,
): HookRegistration {
  // Start times by call id; a tool call is short-lived, so the map stays
  // small and entries are removed on completion.
  const started = new Map<string, number>();
  return hook(ToolTask, {
    beforeTool: async (call: ToolHookCall) => {
      started.set(call.id, Date.now());
      return undefined;
    },
    afterTool: async (call: ToolHookCall, result, api) => {
      const start = started.get(call.id) ?? Date.now();
      started.delete(call.id);
      try {
        const chatId = await chatOfConversation(api.conversationId);
        if (chatId === null) return result;
        const run = await store.runs.runningRunTraceForChat(chatId);
        if (run === null) return result;
        const end = Date.now();
        await trace.recordSpan({
          span_id: uuidv7(),
          trace_id: run.run_id,
          run_id: run.run_id,
          org_id: run.org_id,
          user_id: run.user_id,
          session_id: run.session_id,
          chat_id: chatId,
          name: call.name,
          span_type: "tool",
          status: result.isError === true ? "error" : "ok",
          start_time: new Date(start),
          end_time: new Date(end),
          duration_ms: end - start,
          error: result.isError === true ? textOf(result.output) : "",
          input: textOf(call.arguments),
          output: textOf(result.output),
          attributes: {
            tool: call.name,
            call_id: call.id,
            parent_call_id: call.parent?.callId ?? null,
          },
        });
      } catch {
        // Tracing never blocks or changes a tool call.
      }
      return result;
    },
  });
}
