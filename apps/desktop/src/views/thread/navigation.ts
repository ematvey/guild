// The thread display transition: the route owns `chatId`, while the view
// shows `displayedChatId` until the target's first ThreadState and child
// tree are both in. The reducer keeps the target's state in its per-chat
// cache; this module only decides when the one visible swap happens.

export type NavigationPhase = "idle" | "pending" | "swap" | "cancel" | "cold";

export interface NavigationState {
  phase: NavigationPhase;
  displayedChatId: string | null;
  pendingChatId: string | null;
  /** The pending chat's first ThreadState has been applied. */
  stateReady: boolean;
  /** The pending chat's child tree is cached, fetched, or failed. */
  treeReady: boolean;
}

export type NavigationEvent =
  | { type: "open"; chatId: string | null; cached: boolean; treeKnown: boolean }
  | { type: "state"; chatId: string }
  | { type: "tree"; chatId: string; ok: boolean }
  | { type: "tree-timeout"; chatId: string }
  | { type: "cancel" };

export interface NavigationDecision {
  state: NavigationState;
  /** Present when this transition displays a chat (null = scratch view). */
  swapTo?: string | null;
  /** The chat whose child tree must be fetched now. */
  fetchTree?: string;
  /** Abort the pending chat's in-flight child tree fetch. */
  abortTree?: boolean;
  /** A cold deep link may show the skeleton. */
  cold?: boolean;
}

export function initialNavigation(): NavigationState {
  return {
    phase: "idle",
    displayedChatId: null,
    pendingChatId: null,
    stateReady: false,
    treeReady: false,
  };
}

function swapped(
  state: NavigationState,
  chatId: string | null,
  abortTree: boolean,
): NavigationDecision {
  return {
    state: {
      ...state,
      phase: "swap",
      displayedChatId: chatId,
      pendingChatId: null,
      stateReady: true,
      treeReady: true,
    },
    swapTo: chatId,
    ...(abortTree ? { abortTree: true } : {}),
  };
}

/** Applies one navigation event. The caller owns the side effects named in
 *  the decision: the reducer open, the tree fetch/abort and the state
 *  setters. */
export function transitionNavigation(
  state: NavigationState,
  event: NavigationEvent,
): NavigationDecision {
  switch (event.type) {
    case "open": {
      if (event.chatId === state.displayedChatId) {
        // Back to the visible chat: drop any pending target and keep the
        // view exactly as it is.
        return {
          state: { ...initialNavigation(), displayedChatId: state.displayedChatId },
          ...(state.pendingChatId !== null ? { abortTree: true } : {}),
        };
      }
      if (event.cached) {
        // The reducer already has a synced view, even when it is empty.
        return swapped(state, event.chatId, state.pendingChatId !== null);
      }
      if (event.chatId === null) {
        // The scratch composer is not fetched: it swaps at once, before any
        // target state exists.
        return swapped(state, null, state.pendingChatId !== null);
      }
      const cold = state.displayedChatId === null;
      return {
        state: {
          phase: cold ? "cold" : "pending",
          displayedChatId: state.displayedChatId,
          pendingChatId: event.chatId,
          stateReady: false,
          treeReady: event.treeKnown,
        },
        fetchTree: event.treeKnown ? undefined : event.chatId,
        ...(state.pendingChatId !== null && state.pendingChatId !== event.chatId
          ? { abortTree: true }
          : {}),
        cold,
      };
    }

    case "state": {
      if (event.chatId !== state.pendingChatId) return { state };
      if (state.stateReady) return { state };
      const next = { ...state, stateReady: true };
      if (next.treeReady) return swapped(next, event.chatId, false);
      return { state: next };
    }

    case "tree":
    case "tree-timeout": {
      if (event.chatId !== state.pendingChatId) return { state };
      if (state.treeReady) return { state };
      const next = { ...state, treeReady: true };
      if (next.stateReady) return swapped(next, event.chatId, false);
      return { state: next };
    }

    case "cancel": {
      return {
        state: { ...initialNavigation(), displayedChatId: state.displayedChatId },
        ...(state.pendingChatId !== null ? { abortTree: true } : {}),
      };
    }
  }
}
