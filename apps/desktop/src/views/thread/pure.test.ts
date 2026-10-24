// Tests for the pure derivations extracted from the thread view: route
// resolution, sidebar status, tool labels/previews and stamps.
import { describe, expect, it } from "vitest";
import { applyRoutePatch, chatRoutePath, parseChatRoute } from "./route";
import { statusFromThreads } from "./status";
import { codemodeDuration, safeUrl, toolKind, toolPreview } from "./tool-text";
import { prettyStamp } from "./blocks";
import type { ToolBlock } from "../../lib/thread-reducer";
import type { ChatSummary } from "../../transport";

const route = () => parseChatRoute("/chats");

const tool = (over: Partial<ToolBlock>): ToolBlock => ({
  callId: "c1",
  name: "execute",
  args: "{}",
  executor: "server",
  status: "done",
  ...over,
});

describe("applyRoutePatch (navigation precedence)", () => {
  it("opens a thread and drops the scratch composer", () => {
    const next = applyRoutePatch(route(), { chatId: "c1", newChat: true });
    expect(next.chatId).toBe("c1");
    expect(next.newChat).toBe(false);
    expect(chatRoutePath(next.chatId, next.projectId, next.overlay, next.skills, next.tab, next.settingsSection, next.settingsDetail, next.newChat, next.agents)).toBe("/thread/c1");
  });

  it("a project-bound address implies the Work tab", () => {
    const next = applyRoutePatch(route(), { projectId: "p1", newChat: true });
    expect(next.tab).toBe("work");
    expect(next.newChat).toBe(true);
  });

  it("a chat navigation drops the skills page", () => {
    const skills = parseChatRoute("/skills/alpha");
    const next = applyRoutePatch(skills, { chatId: "c1" });
    expect(next.skills).toBeNull();
    expect(next.chatId).toBe("c1");
  });

  it("an overlay close keeps the skills page", () => {
    const skills = parseChatRoute("/skills");
    const closed = applyRoutePatch(skills, { overlay: null });
    expect(closed.skills).not.toBeNull();
    expect(closed.overlay).toBeNull();
  });

  it("opening an overlay drops the skills page", () => {
    const next = applyRoutePatch(parseChatRoute("/skills"), { overlay: { kind: "device" } });
    expect(next.skills).toBeNull();
  });

  it("a tab pick drops the open thread and the scratch composer", () => {
    const thread = parseChatRoute("/thread/c1");
    const next = applyRoutePatch(thread, { tab: "chats", chatId: null, projectId: null });
    expect(next.tab).toBe("chats");
    expect(next.chatId).toBeNull();
  });

  it("a settings section pick resets the sub-page unless it names one", () => {
    const settings = applyRoutePatch(route(), {
      tab: "settings",
      settingsSection: "models",
      settingsDetail: "route-a",
    });
    expect(settings.settingsDetail).toBe("route-a");
    const picked = applyRoutePatch(settings, { settingsSection: "account" });
    expect(picked.settingsSection).toBe("account");
    expect(picked.settingsDetail).toBeNull();
  });

  it("leaving the Settings tab drops its section and detail", () => {
    const settings = applyRoutePatch(route(), { tab: "settings", settingsSection: "account" });
    const next = applyRoutePatch(settings, { tab: "chats" });
    expect(next.settingsSection).toBeNull();
    expect(next.settingsDetail).toBeNull();
  });

  it("an agents route replaces the chat page and a chat navigation drops it", () => {
    const agents = applyRoutePatch(route(), { agents: { view: "inbox" } as never });
    expect(agents.agents).not.toBeNull();
    const next = applyRoutePatch(agents, { chatId: "c1" });
    expect(next.agents).toBeNull();
  });
});

describe("statusFromThreads", () => {
  it("maps the generating and unread flags by chat id", () => {
    const chats = [
      { id: "a", generating: true, unread: false },
      { id: "b", generating: false, unread: true },
    ] as ChatSummary[];
    expect(statusFromThreads(chats)).toEqual({
      a: { generating: true, unread: false },
      b: { generating: false, unread: true },
    });
  });
});

describe("toolKind / toolPreview", () => {
  it("names the native web kinds before the wire name", () => {
    expect(toolKind(tool({ kind: "web_search", name: "int_searxng_search" }))).toBe("search");
    expect(toolKind(tool({ kind: "web_browse", name: "whatever" }))).toBe("fetch");
  });

  it("maps the legacy wire names to their widget", () => {
    expect(toolKind(tool({ name: "bash" }))).toBe("terminal");
    expect(toolKind(tool({ name: "read_file" }))).toBe("read");
    expect(toolKind(tool({ name: "edit_file" }))).toBe("diff");
    expect(toolKind(tool({ name: "codemode" }))).toBe("codemode");
  });

  it("shows the request on the header line", () => {
    expect(toolPreview(tool({ kind: "web_search", meta: { title: "guild" } }))).toBe("guild");
    expect(toolPreview(tool({ kind: "web_browse", meta: { url: "https://x.test/a" } }))).toBe("https://x.test/a");
    expect(toolPreview(tool({ name: "execute", args: '{"command":"ls -la"}' }))).toBe("ls -la");
    expect(toolPreview(tool({ name: "read_file", args: '{"path":"/tmp/a"}' }))).toBe("/tmp/a");
    expect(toolPreview(tool({ name: "mystery", meta: { title: "hello" } }))).toBe("hello");
  });
});

describe("codemodeDuration", () => {
  it("shows milliseconds, seconds and minutes", () => {
    expect(codemodeDuration(340)).toBe("340ms");
    expect(codemodeDuration(1234)).toBe("1.2s");
    expect(codemodeDuration(65_000)).toBe("1m5s");
  });
});

describe("safeUrl", () => {
  it("accepts only http(s) links", () => {
    expect(safeUrl("https://example.test/a")).toBe("https://example.test/a");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,hi")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe("prettyStamp", () => {
  it("shows only the time for today", () => {
    const now = new Date();
    expect(prettyStamp(now.toISOString())).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns an empty string for an invalid stamp", () => {
    expect(prettyStamp("not-a-date")).toBe("");
  });
});
