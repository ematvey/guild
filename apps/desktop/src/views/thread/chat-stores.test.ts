// The chat stores apply pushed lists and rows: a list replaces the rows and
// merges status, a row replaces its entry or joins at its activity position,
// an activity stamp only moves forward, and a reset empties everything.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSummary } from "../../lib/api/chats";
import {
  applyChatList,
  applyChatRow,
  bumpChatActivity,
  chatsStore,
  chatStatusStore,
  resetChatStores,
  resetSubagentTrees,
  setSubagentTree,
  sidebarRow,
  subagentTreesStore,
  upsertChatRow,
} from "./chat-stores";
import { resetSessionState } from "../../lib/session-reset";

function row(id: string, at: string, extra: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    org_id: "o",
    user_id: "u",
    title: id,
    created_at: at,
    generating: false,
    unread: false,
    working: false,
    blocked: false,
    last_activity_at: at,
    machine_online: false,
    type: "user",
    archived: false,
    deleted: false,
    ...extra,
  } as ChatSummary;
}

afterEach(() => resetChatStores());

describe("chat stores", () => {
  it("a list replaces the rows and merges status, keeping a child chat's entry", () => {
    chatStatusStore.set({ child: { generating: true, working: false, unread: false } });
    applyChatList([row("a", "2026-11-01T00:00:00Z", { unread: true })]);
    expect(chatsStore.get()?.map((c) => c.id)).toEqual(["a"]);
    expect(chatStatusStore.get()).toMatchObject({
      a: { unread: true, generating: false },
      child: { generating: true },
    });
  });

  it("a row replaces its entry, or joins at its recent-activity position", () => {
    const rows = [row("new", "2026-11-03T00:00:00Z"), row("old", "2026-11-01T00:00:00Z")];
    expect(upsertChatRow(rows, row("mid", "2026-11-02T00:00:00Z")).map((c) => c.id)).toEqual(["new", "mid", "old"]);
    expect(upsertChatRow(rows, row("oldest", "2026-10-01T00:00:00Z")).map((c) => c.id)).toEqual([
      "new",
      "old",
      "oldest",
    ]);
    expect(upsertChatRow(rows, row("newest", "2026-11-04T00:00:00Z")).map((c) => c.id)).toEqual([
      "newest",
      "new",
      "old",
    ]);
    expect(upsertChatRow(rows, row("old", "2026-11-01T00:00:00Z", { title: "Renamed" }))[1]!.title).toBe("Renamed");
  });

  it("a row before the first list sets status but makes no list", () => {
    applyChatRow(row("a", "2026-11-01T00:00:00Z", { generating: true }));
    expect(chatsStore.get()).toBeNull();
    expect(chatStatusStore.get().a?.generating).toBe(true);
  });

  it("moves a chat's activity forward only", () => {
    applyChatList([row("a", "2026-11-02T00:00:00Z")]);
    bumpChatActivity("a", "2026-11-01T00:00:00Z");
    expect(chatsStore.get()![0]!.last_activity_at).toBe("2026-11-02T00:00:00Z");
    bumpChatActivity("a", "2026-11-03T00:00:00Z");
    expect(chatsStore.get()![0]!.last_activity_at).toBe("2026-11-03T00:00:00Z");
  });

  it("shows a row's flags from its status entry and subtree", () => {
    const r = row("a", "2026-11-01T00:00:00Z", { unread: true });
    const shown = sidebarRow(
      r,
      { a: { generating: false, working: false, unread: false } },
      {
        a: [
          {
            thread_id: "t",
            chat_id: "c",
            parent_thread_id: null,
            agent_name: "x",
            title: "",
            depth: 1,
            status: "running",
          },
        ],
      },
    );
    expect(shown).toMatchObject({ unread: false, generating: false, working: true });
  });

  it("caches trees per chat, and a reconnect or sign-out drops them", () => {
    setSubagentTree("a", []);
    expect(subagentTreesStore.get()).toEqual({ a: [] });
    resetSubagentTrees();
    expect(subagentTreesStore.get()).toEqual({});
    applyChatList([row("a", "2026-11-01T00:00:00Z")]);
    resetSessionState();
    expect(chatsStore.get()).toBeNull();
    expect(chatStatusStore.get()).toEqual({});
  });
});
