// Caps tool execution and approval-time discovery per conversation. The
// codemode wrapper holds no slot while it waits for its nested calls.
// Installed extensions share the same limiter, so a large Promise.all
// batch cannot flood an integration's execution or discovery endpoints.

import type { Registry, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";

/** Calls in flight per conversation. */
export const MAX_TOOL_CALLS_IN_FLIGHT = 8;

export interface ToolCallLimiter {
  /** Run `work` once a slot is free; the slot is handed to the next waiter. */
  run<T>(conversationId: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface Slot {
  active: number;
  waiters: (() => void)[];
}

export function createToolCallLimiter(max: number = MAX_TOOL_CALLS_IN_FLIGHT): ToolCallLimiter {
  const slots = new Map<number, Slot>();
  return {
    async run<T>(conversationId: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      let slot = slots.get(conversationId);
      if (slot === undefined) {
        slot = { active: 0, waiters: [] };
        slots.set(conversationId, slot);
      }
      if (slot.active >= max)
        await new Promise<void>((resolve, reject) => {
          const granted = () => {
            signal?.removeEventListener("abort", cancelled);
            resolve();
          };
          const cancelled = () => {
            const index = slot.waiters.indexOf(granted);
            if (index >= 0) slot.waiters.splice(index, 1);
            signal?.removeEventListener("abort", cancelled);
            reject(signal?.reason);
          };
          slot.waiters.push(granted);
          signal?.addEventListener("abort", cancelled, { once: true });
          if (signal?.aborted) cancelled();
        });
      else slot.active += 1;
      try {
        // A slot can be granted just before cancellation reaches its waiter.
        signal?.throwIfAborted();
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
      return limiter.run(
        Number(api.conversationId),
        () => Promise.resolve(tool.execute(args as never, api, context)),
        context.abortSignal,
      ) as Promise<ToolExecutionResult>;
    },
  };
}

/** Configure persists names. Executions must be wrapped where extensions
 * enter the registry, including extensions installed after a turn starts. */
export function toolLimitedRegistry(inner: Registry, limiter: ToolCallLimiter): Registry {
  return {
    install: (extension) =>
      inner.install({
        ...extension,
        tools: extension.tools?.map((tool) => withToolCallLimit(tool, limiter)),
      }),
    uninstall: (extension) => inner.uninstall(extension),
    snapshot: () => inner.snapshot(),
    subscribe: (listener) => inner.subscribe(listener),
  };
}
