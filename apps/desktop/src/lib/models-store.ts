// The org's enabled chat models, shared by every picker. The member socket
// pushes the list on connect and whenever an admin changes a route; an HTTP
// read only seeds a store the socket has not filled yet.

import type { ModelOption } from "./api/models";
import { createStore } from "./store";

const models = createStore<ModelOption[] | null>(null);

export const subscribeModels = models.subscribe;

/** The current list, or null until the first push or seed. */
export const modelsSnapshot = models.get;

/** Replaces the list (the `model_list` frame). */
export function applyModelList(next: ModelOption[]): void {
  models.set(next);
}

/** Fills an empty store from an HTTP read. A pushed list is never
 *  overwritten: it is newer than any read that raced it. */
export function seedModelList(next: ModelOption[]): void {
  if (models.get() !== null) return;
  models.set(next);
}

/** Drops the list (sign-out resets it with every other store). */
export const clearModelList = models.reset;
