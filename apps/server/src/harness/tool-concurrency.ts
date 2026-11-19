// Caps how many tool calls one conversation runs at the same time. A
// codemode script launches its nested calls concurrently when the script
// awaits a Promise.all, and one conversation runs one script at a time, so
// this is a per-script cap. Without it a script that batches 200 items sends
// 200 requests at once and the integration answers 429.

import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";

/** Calls in flight per conversation. */
export const MAX_TOOL_CALLS_IN_FLIGHT = 8;

export interface ToolCallLimiter {
  /** Run `work` once a slot is free; the slot is handed to the next waiter. */
  run<T>(conversationId: number, work: () => Promise<T>): Promise<T>;
}

interface Slot {
  active: number;
  waiters: (() => void)[];
}

export function createToolCallLimiter(max: number = MAX_TOOL_CALLS_IN_FLIGHT): ToolCallLimiter {
  const slots = new Map<number, Slot>();
  return {
    async run<T>(conversationId: number, work: () => Promise<T>): Promise<T> {
      let slot = slots.get(conversationId);
      if (slot === undefined) {
        slot = { active: 0, waiters: [] };
        slots.set(conversationId, slot);
      }
      if (slot.active >= max) await new Promise<void>((resolve) => slot.waiters.push(resolve));
      else slot.active += 1;
      try {
        return await work();
      } finally {
        const next = slot.waiters.shift();
        // The released slot passes to the waiter; otherwise it goes away.
        if (next !== undefined) next();
        else {
          slot.active -= 1;
          if (slot.active === 0) slots.delete(conversationId);
        }
      }
    },
  };
}

/** The tool with its execution behind the limiter. The codemode tool itself
 *  is not limited: it holds no slot while its nested calls wait. */
export function withToolCallLimit(tool: ToolRegistration, limiter: ToolCallLimiter): ToolRegistration {
  if (tool.name === CODEMODE_TOOL_NAME) return tool;
  return {
    ...tool,
    async execute(args: unknown, api: ToolExecutionApi, context: Parameters<ToolRegistration["execute"]>[2]) {
      return limiter.run(Number(api.conversationId), () =>
        Promise.resolve(tool.execute(args as never, api, context)),
      ) as Promise<ToolExecutionResult>;
    },
  };
}
