import { describe, expect, it } from "vitest";
import { applyRoutePatch, parseChatRoute } from "../route";
import { commitRoute } from "./use-thread-route";

/** A history stack with one cursor, enough to replay Back. */
function fakeHistory(start: string) {
  const entries = [start];
  let index = 0;
  return {
    get current() { return entries[index]!; },
    get length() { return entries.length; },
    pushState(_d: unknown, _t: string, url?: string | URL | null) {
      entries.splice(index + 1);
      entries.push(String(url));
      index = entries.length - 1;
    },
    replaceState(_d: unknown, _t: string, url?: string | URL | null) {
      entries[index] = String(url);
    },
    back() { index = Math.max(0, index - 1); },
  };
}

describe("commitRoute (history entries per navigation)", () => {
  it("a normalising rewrite replaces the entry, so Back leaves the thread", () => {
    const history = fakeHistory("/chats");
    const bare = parseChatRoute("/thread/c1", "");
    commitRoute(history, history.current, applyRoutePatch(parseChatRoute("/chats", ""), { chatId: "c1" }));
    expect(history.current).toBe("/thread/c1");
    commitRoute(history, history.current, applyRoutePatch(bare, { projectId: "p1" }), { replace: true });
    expect(history.current).toBe("/project/p1/thread/c1");
    expect(history.length).toBe(2);
    history.back();
    expect(history.current).toBe("/chats");
  });

  it("a plain navigation adds an entry", () => {
    const history = fakeHistory("/chats");
    commitRoute(history, history.current, applyRoutePatch(parseChatRoute("/chats", ""), { chatId: "c1" }));
    expect(history.length).toBe(2);
  });

  it("an unchanged address writes nothing", () => {
    const history = fakeHistory("/thread/c1");
    commitRoute(history, history.current, parseChatRoute("/thread/c1", ""));
    expect(history.length).toBe(1);
  });
});
