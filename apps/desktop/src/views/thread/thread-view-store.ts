// The thread view's visible state as one external store: the reducer's
// per-chat views plus the navigation machine that decides which chat is on
// screen. Readers take one snapshot (useSyncExternalStore); writers go
// through `mutate` and `navigate`, which republish it. Nothing here is
// copied into React state, so blocks, the older-page cursor, the compaction
// line and the loading flag cannot disagree about which chat they describe.
import { createThreadReducer, type RenderBlock, type ThreadReducer } from "../../lib/thread-reducer";
import {
  initialNavigation,
  transitionNavigation,
  type NavigationDecision,
  type NavigationEvent,
  type NavigationState,
} from "./navigation";

export interface ThreadViewSnapshot {
  /** The chat on screen (null = the scratch composer). */
  displayedChatId: string | null;
  /** The route chat whose first state or tree is still on its way. */
  pendingChatId: string | null;
  navigating: boolean;
  /** Nothing to show yet: a cold deep link before its first state. */
  loading: boolean;
  /** An authoritative ThreadState has built the displayed view. A reconnect
   *  keeps it: the view still has content while the resync runs. */
  synced: boolean;
  blocks: RenderBlock[];
  /** An older page exists before the loaded window. */
  hasMore: boolean;
  /** The loaded window's oldest seq (-1 = nothing loaded). */
  oldestSeq: number;
  /** A compaction runs for the displayed chat (the server's flag, or a
   *  manual /compact the server has not reported yet). */
  compacting: boolean;
}

export interface ThreadViewStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ThreadViewSnapshot;
  /** Runs one reducer transition and republishes the snapshot. */
  mutate<T>(fn: (reducer: ThreadReducer) => T): T;
  /** Applies one navigation event; a swap opens its target in the reducer.
   *  The caller owns the decision's side effects (tree fetch, timers). */
  navigate(event: NavigationEvent): NavigationDecision;
  navigation(): NavigationState;
  /** A ThreadState for this chat reached the reducer. */
  markSynced(chatId: string): void;
  /** A first send's created chat: the scratch screen shows its optimistic
   *  view until the navigation to it swaps. */
  seed(chatId: string): void;
}

const SNAPSHOT_KEYS: (keyof ThreadViewSnapshot)[] = [
  "displayedChatId", "pendingChatId", "navigating", "loading", "synced",
  "blocks", "hasMore", "oldestSeq", "compacting",
];

export function createThreadViewStore(
  initialChatId: string | null,
  reducer: ThreadReducer = createThreadReducer(),
): ThreadViewStore {
  let nav = initialNavigation();
  // A route chat before its first navigation event: the skeleton, not an
  // empty thread.
  let booting = initialChatId !== null;
  let synced = false;
  let seeded: string | null = null;
  const listeners = new Set<() => void>();

  const compute = (): ThreadViewSnapshot => {
    const source = nav.displayedChatId ?? seeded;
    const view = reducer.view(source);
    // A seeded target already shows its own content: the wait for its
    // first frame is not a navigation the user can see.
    const waiting = nav.pendingChatId !== null && nav.pendingChatId !== seeded;
    return {
      displayedChatId: nav.displayedChatId,
      pendingChatId: nav.pendingChatId,
      navigating: waiting,
      loading: booting || (waiting && nav.phase === "cold"),
      synced,
      blocks: view.blocks,
      hasMore: view.hasMore,
      oldestSeq: view.oldestSeq,
      compacting: view.compacting,
    };
  };
  let snapshot = compute();

  const publish = (): void => {
    const next = compute();
    if (SNAPSHOT_KEYS.every((key) => Object.is(next[key], snapshot[key]))) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    mutate(fn) {
      const out = fn(reducer);
      publish();
      return out;
    },
    navigate(event) {
      const decision = transitionNavigation(nav, event);
      nav = decision.state;
      booting = false;
      if (event.type === "open" && event.chatId !== seeded) seeded = null;
      if (decision.swapTo !== undefined) {
        // The target's own view owns the screen from here, including its
        // compaction line: nothing of the previous chat carries over.
        synced = reducer.open(decision.swapTo).synced;
        seeded = null;
      }
      publish();
      return decision;
    },
    navigation: () => nav,
    markSynced(chatId) {
      if (chatId !== nav.displayedChatId || synced) return;
      synced = true;
      publish();
    },
    seed(chatId) {
      seeded = chatId;
      publish();
    },
  };
}
