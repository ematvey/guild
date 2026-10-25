import { describe, expect, it } from "vitest";
import {
  initialNavigation,
  transitionNavigation,
  type NavigationEvent,
  type NavigationState,
} from "./navigation";

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
    expect(pending.fetchTree).toBe("child");

    const afterTree = transitionNavigation(pending.state, { type: "tree", chatId: "child", ok: true });
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
    const afterTree = transitionNavigation(afterState.state, { type: "tree", chatId: "child", ok: true });
    expect(afterTree.swapTo).toBe("child");
  });

  it("still swaps after a failed tree fetch", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const withState = transitionNavigation(pending.state, { type: "state", chatId: "child" });
    const afterFailure = transitionNavigation(withState.state, { type: "tree", chatId: "child", ok: false });
    expect(afterFailure.swapTo).toBe("child");
    expect(afterFailure.state.phase).toBe("swap");
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
    expect(second.abortTree).toBe(true);
    expect(second.state.pendingChatId).toBe("child-b");
    expect(second.state.displayedChatId).toBe("parent");
    // A late state for the cancelled target does nothing.
    const late = transitionNavigation(second.state, { type: "state", chatId: "child-a" });
    expect(late.swapTo).toBeUndefined();
    expect(late.state.pendingChatId).toBe("child-b");
  });

  it("a cached swap starts clean so running A cannot leak busy onto idle B", () => {
    const decision = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "running-a" },
      { type: "open", chatId: "cached-idle-b", cached: true, treeKnown: true },
    );
    expect(decision.swapTo).toBe("cached-idle-b");
    expect(decision.clearBusy).toBe(true);
  });

  it("cancels a pending target and keeps the displayed chat", () => {
    const pending = transitionNavigation(
      { ...initialNavigation(), displayedChatId: "parent" },
      { type: "open", chatId: "child", cached: false, treeKnown: false },
    );
    const cancelled = transitionNavigation(pending.state, { type: "cancel" });
    expect(cancelled.abortTree).toBe(true);
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
      { type: "tree", chatId: "deep", ok: true },
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
    expect(back.abortTree).toBe(true);
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
