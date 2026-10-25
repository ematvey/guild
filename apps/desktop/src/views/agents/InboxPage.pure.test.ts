import { describe, expect, it } from "vitest";
import { noticeChatId, noticeText } from "./InboxPage";
import type { AgentNotice } from "./agents-api";

function notice(patch: Partial<AgentNotice>): AgentNotice {
  return {
    id: "n1",
    org_id: "o1",
    agent_id: "a1",
    kind: "agent_message",
    payload: {},
    created_at: "2026-10-25T11:20:00.000Z",
    ...patch,
  };
}

describe("noticeChatId", () => {
  it("reads the canonical thread URL a routine message carries", () => {
    const row = notice({ payload: { url: "/thread/chat-123", title: "Routine test" } });
    expect(noticeChatId(row)).toBe("chat-123");
  });

  it("prefers an explicit chat_id", () => {
    const row = notice({ payload: { chat_id: "chat-9", url: "/thread/chat-123" } });
    expect(noticeChatId(row)).toBe("chat-9");
  });

  it("returns null when the notice names no chat", () => {
    expect(noticeChatId(notice({ payload: { title: "No link" } }))).toBeNull();
    expect(noticeChatId(notice({ payload: { url: "/agents/a1/threads" } }))).toBeNull();
  });
});

describe("noticeText", () => {
  it("uses the title when no message body is present", () => {
    expect(noticeText(notice({ payload: { title: "Routine test" } }))).toBe("Routine test");
  });
});
