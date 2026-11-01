// Each chat's context usage, as the member socket pushes it: inside the
// chat's sync bracket and whenever a turn or a compaction moves it. The
// composer's context meter reads it from here; nothing fetches it.

import { useSyncExternalStore } from "react";

/** One chat's measured usage: the last completed request's tokens and the
 *  model it ran on. */
export interface ContextUsage {
  tokens: number | null;
  usage_model: string | null;
  /** Display name of `usage_model`; null when that route is gone or unnamed. */
  usage_model_alias: string | null;
}

const usages = new Map<string, ContextUsage>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replaces one chat's usage (the `context_usage` frame). */
export function applyContextUsage(chatId: string, usage: ContextUsage): void {
  usages.set(chatId, usage);
  emit();
}

/** The chat's usage, or undefined until its first frame. */
export function contextUsageOf(chatId: string): ContextUsage | undefined {
  return usages.get(chatId);
}

/** The chat's usage, re-rendering when a frame replaces it. */
export function useContextUsage(chatId: string | null): ContextUsage | undefined {
  const read = () => (chatId === null ? undefined : usages.get(chatId));
  return useSyncExternalStore(subscribe, read, read);
}

/** Drops every chat's usage; sign-out clears it. */
export function clearContextUsage(): void {
  usages.clear();
  emit();
}
