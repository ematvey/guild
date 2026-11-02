// Each chat's context usage, as the member socket pushes it: inside the
// chat's sync bracket and whenever a turn or a compaction moves it. The
// composer's context meter reads it from here; nothing fetches it.

import { createStore } from "./store";

/** One chat's measured usage: the last completed request's tokens and the
 *  model it ran on. */
export interface ContextUsage {
  tokens: number | null;
  usage_model: string | null;
  /** Display name of `usage_model`; null when that route is gone or unnamed. */
  usage_model_alias: string | null;
}

const usages = createStore<ReadonlyMap<string, ContextUsage>>(new Map());

/** Replaces one chat's usage (the `context_usage` frame). */
export function applyContextUsage(chatId: string, usage: ContextUsage): void {
  usages.update((prev) => new Map(prev).set(chatId, usage));
}

/** The chat's usage, or undefined until its first frame. */
export function contextUsageOf(chatId: string): ContextUsage | undefined {
  return usages.get().get(chatId);
}

/** The chat's usage, re-rendering when a frame replaces it. */
export function useContextUsage(chatId: string | null): ContextUsage | undefined {
  return usages.use((map) => (chatId === null ? undefined : map.get(chatId)));
}

/** Drops every chat's usage (sign-out resets it with every other store). */
export const clearContextUsage = usages.reset;
