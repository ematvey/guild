import { describe, expect, it } from "vitest";
import {
  initialNavigation,
  transitionNavigation,
  type NavigationEvent,
  type NavigationState,
} from "./navigation";
import { busyFrom } from "./status";

const run = (events: NavigationEvent[], state = initialNavigation()): NavigationState => {
  let current = state;
  for (const event of events) current = transitionNavigation(current, event).state;
  return current;
};

describe("thread navigation transitions", () => {
  it("swaps immediately to a cached chat, including an empty one", () => {
    const decision = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "empty", cached: true, treeKnown: true },
    );
    expect(decision.swapTo).toBe("empty");
    expect(decision.state.phase).toBe("swap");
    expect(decision.state.displayedChatId).toBe("empty");
    expect(decision.state.pendingChatId).toBeNull();
    expect(decision.cold).toBeUndefined();
  });

  it("keeps the old thread until the first visit's state and tree are both in", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    expect(pending.swapTo).toBeUndefined();
    expect(pending.state.phase).toBe("pending");
    expect(pending.state.displayedChatId).toBe("parent");
    expect(pending.state.pendingChatId).toBe("child");

    const afterTree = transitionNavigation(pending.state, { type: "tree", chatId: "child" });
    expect(afterTree.swapTo).toBeUndefined();
    expect(afterTree.state.phase).toBe("pending");

    const afterState = transitionNavigation(afterTree.state, { type: "state", chatId: "child" });
    expect(afterState.swapTo).toBe("child");
    expect(afterState.state.phase).toBe("swap");
    expect(afterState.state.displayedChatId).toBe("child");
  });

  it("swaps when the state arrives first and the tree lands later", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const afterState = transitionNavigation(pending.state, { type: "state", chatId: "child" });
    expect(afterState.swapTo).toBeUndefined();
    const afterTree = transitionNavigation(afterState.state, { type: "tree", chatId: "child" });
    expect(afterTree.swapTo).toBe("child");
  });

  it("keeps the target busy when a state-first swap is driven by a tree timeout", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const afterState = transitionNavigation(pending.state, { type: "state", chatId: "child" });
    const timedOut = transitionNavigation(afterState.state, { type: "tree-timeout", chatId: "child" });
    expect(timedOut.swapTo).toBe("child");
  });

  it("keeps the target busy when its state and known tree swap together", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: true },
    );
    const afterState = transitionNavigation(pending.state, { type: "state", chatId: "child" });
    expect(afterState.swapTo).toBe("child");
  });

  it("swaps after a slow tree timeout once the state is in", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const withState = transitionNavigation(pending.state, { type: "state", chatId: "child" });
    const timedOut = transitionNavigation(withState.state, { type: "tree-timeout", chatId: "child" });
    expect(timedOut.swapTo).toBe("child");
  });

  it("cancels the old pending work when navigation moves again", () => {
    const first = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child-a", cached: false, treeKnown: false },
    );
    const second = transitionNavigation(first.state, {
      type: "open",
      chatId: "child-b",
      cached: false,
      treeKnown: false,
    });
    expect(second.state.pendingChatId).toBe("child-b");
    expect(second.state.displayedChatId).toBe("parent");
    // A late state for the cancelled target does nothing.
    const late = transitionNavigation(second.state, { type: "state", chatId: "child-a" });
    expect(late.swapTo).toBeUndefined();
    expect(late.state.pendingChatId).toBe("child-b");
  });

  it("a cached swap cannot leak running A's turn onto idle B", () => {
    const decision = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "running-a" },
      { type: "open", chatId: "cached-idle-b", cached: true, treeKnown: true },
    );
    expect(decision.swapTo).toBe("cached-idle-b");
    // The turn state derives from the displayed chat, so the swap has no
    // flag to clear: B's own generating decides.
    expect(busyFrom(false, null, decision.state.displayedChatId)).toBe(false);
  });

  it("cancels a pending target and keeps the displayed chat", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const cancelled = transitionNavigation(pending.state, { type: "cancel" });
    expect(cancelled.swapTo).toBeUndefined();
    expect(cancelled.state.phase).toBe("idle");
    expect(cancelled.state.displayedChatId).toBe("parent");
    expect(cancelled.state.pendingChatId).toBeNull();
    expect(cancelled.state.stateReady).toBe(false);
    expect(cancelled.state.treeReady).toBe(false);
  });

  it("shows a cold deep link as a cold pending view", () => {
    const cold = transitionNavigation(initialNavigation(), {
      type: "open",
      chatId: "deep",
      cached: false,
      treeKnown: false,
    });
    expect(cold.state.phase).toBe("cold");
    expect(cold.cold).toBe(true);
    expect(cold.state.displayedChatId).toBeNull();
    expect(cold.state.pendingChatId).toBe("deep");
    const ready = run([
      { type: "open", chatId: "deep", cached: false, treeKnown: false },
      { type: "tree", chatId: "deep" },
      { type: "state", chatId: "deep" },
    ]);
    expect(ready.phase).toBe("swap");
    expect(ready.displayedChatId).toBe("deep");
  });

  it("cancels a cold pending target when the route returns to the displayed chat", () => {
    const cold = transitionNavigation(initialNavigation(), {
      type: "open",
      chatId: "deep",
      cached: false,
      treeKnown: false,
    });
    expect(cold.state.phase).toBe("cold");
    const back = transitionNavigation(cold.state, {
      type: "open",
      chatId: null,
      cached: false,
      treeKnown: true,
    });
    expect(back.swapTo).toBeUndefined();
    expect(back.state.phase).toBe("idle");
    expect(back.state.pendingChatId).toBeNull();
    expect(back.state.displayedChatId).toBeNull();
  });

  it("does nothing when the route opens the chat already on screen", () => {
    const state = { ...initialNavigation(), displayedChatId: "open" };
    const decision = transitionNavigation(state, {
      type: "open",
      chatId: "open",
      cached: true,
      treeKnown: true,
    });
    expect(decision.swapTo).toBeUndefined();
    expect(decision.state.displayedChatId).toBe("open");
    expect(decision.state.pendingChatId).toBeNull();
  });
});
