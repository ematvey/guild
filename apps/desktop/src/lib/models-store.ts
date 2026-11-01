// The org's enabled chat models, shared by every picker. The member socket
// pushes the list on connect and whenever an admin changes a route; an HTTP
// read only seeds a store the socket has not filled yet.

import type { ModelOption } from "./api/models";

let snapshot: ModelOption[] | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current list, or null until the first push or seed. */
export function modelsSnapshot(): ModelOption[] | null {
  return snapshot;
}

/** Replaces the list (the `model_list` frame). */
export function applyModelList(models: ModelOption[]): void {
  snapshot = models;
  emit();
}

/** Fills an empty store from an HTTP read. A pushed list is never
 *  overwritten: it is newer than any read that raced it. */
export function seedModelList(models: ModelOption[]): void {
  if (snapshot !== null) return;
  applyModelList(models);
}

/** Drops the list; sign-out clears it so the next session starts empty. */
export function clearModelList(): void {
  snapshot = null;
  emit();
}
