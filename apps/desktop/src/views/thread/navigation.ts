// The thread display transition: the route owns `chatId`, while the view
// shows `displayedChatId` until the target's first ThreadState and its tree
// facts are both in (the sync bracket pushes the tree before the state). The reducer keeps the target's state in its per-chat
// cache; this module only decides when the one visible swap happens.

export type NavigationPhase = "idle" | "pending" | "swap" | "cancel" | "cold";

export interface NavigationState {
  phase: NavigationPhase;
  displayedChatId: string | null;
  pendingChatId: string | null;
  /** The pending chat's first ThreadState has been applied. */
  stateReady: boolean;
  /** The pending chat's tree facts are cached or pushed, or the wait for
   *  them timed out. */
  treeReady: boolean;
}

export type NavigationEvent =
  | { type: "open"; chatId: string | null; cached: boolean; treeKnown: boolean }
  | { type: "state"; chatId: string }
  | { type: "tree"; chatId: string }
  | { type: "tree-timeout"; chatId: string }
  | { type: "cancel" };

export interface NavigationDecision {
  state: NavigationState;
  /** Present when this transition displays a chat (null = scratch view). */
  swapTo?: string | null;
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

function swapped(state: NavigationState, chatId: string | null): NavigationDecision {
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
  };
}

/** Applies one navigation event. The caller owns the side effects named in
 *  the decision: the reducer open and the state setters. */
export function transitionNavigation(
  state: NavigationState,
  event: NavigationEvent,
): NavigationDecision {
  switch (event.type) {
    case "open": {
      if (event.chatId === state.displayedChatId) {
        // Back to the visible chat: drop any pending target and keep the
        // view exactly as it is.
        return { state: { ...initialNavigation(), displayedChatId: state.displayedChatId } };
      }
      if (event.cached) {
        // The reducer already has a synced view, even when it is empty.
        return swapped(state, event.chatId);
      }
      if (event.chatId === null) {
        // The scratch composer has no state to wait for: it swaps at once, before any
        // target state exists.
        return swapped(state, null);
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
        cold,
      };
    }

    case "state": {
      if (event.chatId !== state.pendingChatId) return { state };
      if (state.stateReady) return { state };
      const next = { ...state, stateReady: true };
      if (next.treeReady) return swapped(next, event.chatId);
      return { state: next };
    }

    case "tree":
    case "tree-timeout": {
      if (event.chatId !== state.pendingChatId) return { state };
      if (state.treeReady) return { state };
      const next = { ...state, treeReady: true };
      if (next.stateReady) return swapped(next, event.chatId);
      return { state: next };
    }

    case "cancel": {
      return { state: { ...initialNavigation(), displayedChatId: state.displayedChatId } };
    }
  }
}
