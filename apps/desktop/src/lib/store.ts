// A module-level value React views subscribe to: the socket frames write
// it, views read it through useSyncExternalStore. Every store made here
// resets to its initial value on sign-out.

import { useSyncExternalStore } from "react";
import { registerSessionReset } from "./session-reset";

export interface Store<T> {
  get(): T;
  /** Replaces the value and notifies subscribers; a same-reference value
   *  notifies nobody. */
  set(next: T): void;
  update(change: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
  /** The value (or a slice of it), re-rendering when it changes. */
  use(): T;
  use<S>(select: (value: T) => S): S;
  /** Back to the initial value. */
  reset(): void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of listeners) listener();
  };
  const store: Store<T> = {
    get: () => value,
    set,
    update: (change) => set(change(value)),
    subscribe,
    use: <S>(select?: (value: T) => S) => {
      const read = () => (select === undefined ? value : select(value));
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(subscribe, read, read) as S;
    },
    reset: () => set(initial),
  };
  registerSessionReset(store.reset);
  return store;
}
