// Pure-logic tests for the thread view's highest-risk functions (no DOM, no
// server). These run under `npm test` (vitest); see package.json.

import { describe, expect, it } from "vitest";
import {
  busyAfterThreadPush,
  sendButtonState,
  threadAccess,
  pruneStopping,
  statusFromThreads,
  offlineMachine,
  tabPaneLayout,
} from "./status";
import { chatRoutePath, isImeEnter, parseChatRoute } from "./route";
import { DEFAULT_USAGE } from "../settings/usage-route";
import { AGENTS_ACTIVITY } from "../agents/agents-route";
import { mentionCandidates, composerSkills } from "./mentions";
import { accountDefaultLabel } from "./approval";
import { parseSearchResults, toolLabel, toolDisplayName } from "./tool-text";
import { compareVersions } from "../skills/version";
import { viewEntries, workRunLabel } from "../worked-for-block";
import {
  artifactCardOf,
  eventsToBlocks,
  reconcilePendingSend,
  replayFrom,
  resolveApproval,
  threadStateBlocks,
  upsertApproval,
  type Block,
} from "../../lib/thread-reducer";
import type { ChatRoute } from "./route";
import type { ApprovalPolicy } from "../../lib/api/approvals";
import type { ThreadEvent, ThreadEventRow } from "../../lib/thread-events";

function row(seq: number, event: ThreadEvent): ThreadEventRow {
  return { id: `e${seq}`, seq, event, created_at: "t" };
}

const usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

describe("thread access", () => {
  const base = {
    chatId: "child-chat",
    chats: [{ id: "parent-chat" }],
    archivedChats: [{ id: "archived-chat" }],
    childTree: null,
  };

  it("treats an unknown thread as unknown, never editable", () => {
    expect(threadAccess(base)).toBe("unknown");
    expect(threadAccess({ ...base, chats: null })).toBe("unknown");
    expect(threadAccess({ ...base, archivedChats: null })).toBe("unknown");
  });

  it("keeps active chats writable and archived chats read-only", () => {
    expect(threadAccess({ ...base, chats: [{ id: "child-chat" }] })).toBe("writable");
    expect(threadAccess({ ...base, archivedChats: [{ id: "child-chat" }] })).toBe("readonly");
  });

  it("lets active membership win over a late archived list", () => {
    expect(threadAccess({
      ...base,
      chats: [{ id: "child-chat" }],
      archivedChats: [{ id: "child-chat" }],
    })).toBe("writable");
  });

  it("marks a child tree with a parent read-only even before the lists load", () => {
    expect(threadAccess({
      ...base,
      chats: null,
      archivedChats: null,
      childTree: { parent: { chat_id: "parent" } },
    })).toBe("readonly");
  });

  it("falls back to read-only when a synced child's tree fetch failed", () => {
    expect(threadAccess({
      ...base,
      treeFailed: true,
      synced: true,
    })).toBe("readonly");
  });

  it("keeps the composer editable for a just-created chat whose row is in flight", () => {
    expect(threadAccess({
      ...base,
      chats: [],
      archivedChats: [],
      treeFailed: true,
      synced: true,
      justCreated: true,
    })).toBe("writable");
  });

  it("does not use the failed-tree fallback before the view is synced", () => {
    expect(threadAccess({
      ...base,
      treeFailed: true,
      synced: false,
    })).toBe("unknown");
  });

  it("never marks the scratch composer read-only", () => {
    expect(threadAccess({ ...base, chatId: null })).toBe("writable");
  });
});

describe("parseChatRoute / chatRoutePath", () => {
  const roundTrip = (path: string) => {
    const r = parseChatRoute(path);
    return chatRoutePath(r.chatId, r.projectId, r.overlay, r.skills, r.tab, r.settingsSection, r.settingsDetail, r.newChat);
  };

  it("owns the agents surface addresses without touching chat routes", () => {
    const deep = parseChatRoute("/agents/a1/files/notes/today.md");
    expect(deep.agents).toEqual({
      view: "agent",
      agentId: "a1",
      tab: "files",
      filePath: "notes/today.md",
    });
    expect(
      chatRoutePath(
        deep.chatId,
        deep.projectId,
        deep.overlay,
        deep.skills,
        deep.tab,
        deep.settingsSection,
        deep.settingsDetail,
        deep.newChat,
        deep.agents,
      ),
    ).toBe("/agents/a1/files/notes/today.md");
    expect(parseChatRoute("/inbox").agents).toBeNull();
    expect(parseChatRoute("/inbox").tab).toBe("chats");
    expect(parseChatRoute("/activity").agents).toEqual(AGENTS_ACTIVITY);
    expect(parseChatRoute("/runs/r1").agents).toEqual({ view: "run", runId: "r1" });
    expect(parseChatRoute("/sessions/c1").agents).toEqual({ view: "chat", chatId: "c1" });
    expect(parseChatRoute("/traces/t1").agents).toEqual({ view: "trace", traceId: "t1" });
    // A chat deep link still parses as a chat, not an agents route.
    expect(parseChatRoute("/thread/c1").agents).toBeNull();
  });

  it("round-trips every route shape", () => {
    for (const path of [
      "/chats",
      "/chats/new",
      "/work",
      "/work/new",
      "/thread/abc-123",
      "/thread/abc-123/device",
      "/work/device",
      "/project/p1",
      "/project/p1/new",
      "/project/p1/thread/abc-123",
      "/chats/device",
      "/work/device",
      "/settings",
      "/settings/models",
      "/settings/integrations/my-slug",
      "/skills",
      "/skills/activity",
      "/skills/machine",
      "/skills/new",
      "/skills/code-review",
      "/skills/code-review/edit",
    ]) {
      expect(roundTrip(path)).toBe(path);
    }
    // "/" is an alias for the Chats tab; the canonical address is /chats
    expect(chatRoutePath(parseChatRoute("/").chatId, null, null, null, parseChatRoute("/").tab)).toBe("/chats");
  });

  it("parses the rail tabs' own addresses", () => {
    // each panel tab owns a top-level URL; a tab root is no chat open, and
    // /new is the addressed scratch composer
    expect(parseChatRoute("/chats")).toMatchObject({ chatId: null, tab: "chats", newChat: false });
    expect(parseChatRoute("/work")).toMatchObject({ chatId: null, tab: "work", newChat: false });
    expect(parseChatRoute("/chats/new")).toMatchObject({ chatId: null, tab: "chats", newChat: true });
    expect(parseChatRoute("/work/new")).toMatchObject({ chatId: null, tab: "work", newChat: true });
    expect(parseChatRoute("/settings")).toMatchObject({
      chatId: null,
      overlay: null,
      tab: "settings",
    });
    // a project filter implies the Work tab; /new on it is the project's
    // scratch composer with the pick implied by the URL
    expect(parseChatRoute("/project/p1")).toMatchObject({ projectId: "p1", tab: "work", newChat: false });
    expect(parseChatRoute("/project/p1/new")).toMatchObject({
      chatId: null,
      projectId: "p1",
      tab: "work",
      newChat: true,
    });
    // a sectioned settings URL deep-links the tab's section
    expect(parseChatRoute("/settings/models")).toMatchObject({
      tab: "settings",
      settingsSection: "models",
      settingsDetail: null,
    });
    // everything else defaults to the Chats tab
    expect(parseChatRoute("/thread/x")).toMatchObject({ tab: "chats" });
  });

  it("a malformed escape falls back to the default route instead of throwing", () => {
    // decodeURIComponent throws on these; a throw from the render-time route
    // initializer would crash the app into a Reload loop on the same URL.
    for (const path of ["/thread/%E0%A4%A", "/skills/a%", "/settings/models/a%zz"]) {
      expect(parseChatRoute(path)).toMatchObject({
        chatId: null,
        tab: "chats",
        invalid: true,
      });
    }
  });

  it("round-trips a settings detail whose segments hold / and %", () => {
    const r = parseChatRoute("/settings/models");
    const path = chatRoutePath(r.chatId, r.projectId, r.overlay, r.skills, r.tab, "models", "a/b%c");
    const back = parseChatRoute(path);
    expect(back.settingsDetail).toBe("a/b%c");
  });

  it("parses every skills page state; skills is chat-independent and top-level", () => {
    expect(parseChatRoute("/skills").skills).toEqual({
      view: "catalog",
      slug: null,
      editor: null,
    });
    expect(parseChatRoute("/skills/activity").skills).toEqual({
      view: "activity",
      slug: null,
      editor: null,
    });
    expect(parseChatRoute("/skills/machine").skills).toEqual({
      view: "machine",
      slug: null,
      editor: null,
    });
    // "new" is a reserved segment: the create editor, not a detail slug.
    expect(parseChatRoute("/skills/new").skills).toEqual({
      view: "catalog",
      slug: null,
      editor: "new",
    });
    expect(parseChatRoute("/skills/code-review").skills).toEqual({
      view: "catalog",
      slug: "code-review",
      editor: null,
    });
    expect(parseChatRoute("/skills/code-review/edit").skills).toEqual({
      view: "catalog",
      slug: "code-review",
      editor: "code-review",
    });
    // activity/machine/new are reserved: a slug can never collide with
    // them, so tabs parse without a slug lookup.
    for (const reserved of ["activity", "machine", "new"]) {
      expect(parseChatRoute(`/skills/${reserved}`).skills).toMatchObject({ slug: null });
    }
    // the skills page replaces the chat: no thread/project rides along
    const r = parseChatRoute("/skills/code-review");
    expect(r.chatId).toBeNull();
    expect(r.projectId).toBeNull();
    expect(r.overlay).toBeNull();
  });

  it("parses thread + overlay combinations", () => {
    expect(parseChatRoute("/thread/x")).toEqual({
      chatId: "x",
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    expect(parseChatRoute("/thread/x/device")).toEqual({
      chatId: "x",
      projectId: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      overlay: { kind: "device" },
      skills: null,
      agents: null,
      newChat: false,
    });
    // /help deep links alias the onboarding guide (the guide IS the help
    // page); chatRoutePath never emits /help.
    expect(parseChatRoute("/thread/x/help")).toMatchObject({
      chatId: null,
      overlay: { kind: "onboard" },
    });
    expect(parseChatRoute("/help")).toEqual({
      chatId: null,
      projectId: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      overlay: { kind: "onboard" },
      skills: null,
      agents: null,
      newChat: false,
    });
    // onboarding: chat-independent top-level surface, prefixes drop
    expect(parseChatRoute("/onboard")).toEqual({
      chatId: null,
      projectId: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      overlay: { kind: "onboard" },
      skills: null,
      agents: null,
      newChat: false,
    });
    expect(parseChatRoute("/project/p1/thread/c1/onboard")).toMatchObject({
      chatId: null,
      overlay: { kind: "onboard" },
    });
    expect(parseChatRoute("/settings/integrations/a/b")).toEqual({
      chatId: null,
      projectId: null,
      tab: "settings",
      overlay: null,
      skills: null,
      agents: null,
      settingsSection: "integrations",
      settingsDetail: "a/b",
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    // trailing slashes and empty segments are ignored
    expect(parseChatRoute("/thread/x/")).toEqual({
      chatId: "x",
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    expect(parseChatRoute("")).toEqual({
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    // a detail carrying an encoded slash parses to the full id and the
    // rebuilt path is parse-stable from there on
    const deep = parseChatRoute("/settings/integrations/my%2Fslug");
    const once = chatRoutePath(
      deep.chatId,
      deep.projectId,
      deep.overlay,
      deep.skills,
      deep.tab,
      deep.settingsSection,
      deep.settingsDetail,
      deep.newChat,
    );
    expect(parseChatRoute(once).settingsSection).toBe("integrations");
    expect(parseChatRoute(once).settingsDetail).toBe("my/slug");
  });

  it("parses the project filter, with and without an open thread", () => {
    expect(parseChatRoute("/project/p1")).toEqual({
      chatId: null,
      projectId: "p1",
      overlay: null,
      skills: null,
      agents: null,
      tab: "work",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    expect(parseChatRoute("/project/p1/thread/c1")).toEqual({
      chatId: "c1",
      projectId: "p1",
      overlay: null,
      skills: null,
      agents: null,
      tab: "work",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
    // a bare /thread/<id> has no project filter (deep link)
    expect(parseChatRoute("/thread/c1").projectId).toBeNull();
    // /project without an id is not a project route
    expect(parseChatRoute("/project")).toEqual({
      chatId: null,
      projectId: null,
      overlay: null,
      skills: null,
      agents: null,
      tab: "chats",
      settingsSection: null,
      settingsDetail: null,
      usage: DEFAULT_USAGE,
      newChat: false,
    });
  });

  it("addresses the scratch composer per surface", () => {
    // The new-chat composer is a route like any other: back/forward steps
    // between it and open threads, a reload restores it, and the
    // project-bound form carries the pick in the URL.
    expect(chatRoutePath(null, null, null, null, "chats", null, null, true)).toBe("/chats/new");
    expect(chatRoutePath(null, null, null, null, "work", null, null, true)).toBe("/work/new");
    expect(chatRoutePath(null, "p1", null, null, "work", null, null, true)).toBe("/project/p1/new");
    // the segment never survives a chat or overlay (chatless surfaces only)
    expect(chatRoutePath("c1", null, null, null, "chats", null, null, true)).toBe("/thread/c1");
    expect(chatRoutePath(null, null, { kind: "device" }, null, "chats", null, null, true)).toBe("/chats/device");
    // onboarding: always bare /onboard, whatever it rides on; no /help
    // emission — help deep links parse onto /onboard
    expect(chatRoutePath("c1", "p1", { kind: "onboard" })).toBe("/onboard");
    expect(parseChatRoute(chatRoutePath("c1", "p1", { kind: "onboard" }))).toMatchObject({
      overlay: { kind: "onboard" },
    });
    // and never rides on the Settings tab
    expect(chatRoutePath(null, null, null, null, "settings", "models", null, true)).toBe("/settings/models");
    expect(parseChatRoute("/chats/new")).toMatchObject({ newChat: true, chatId: null });
    // a thread address never parses as a scratch composer
    expect(parseChatRoute("/thread/x").newChat).toBe(false);
    // an open thread inside a project keeps the filter, drops the segment
    expect(parseChatRoute("/project/p1/thread/c1").newChat).toBe(false);
  });
});

describe("eventsToBlocks", () => {
  it("replays assistant blocks in stream order and joins tool results", () => {
    const blocks = eventsToBlocks([
      row(2, {
        type: "assistant_message",
        turn: 1,
        step: 1,
        model: "m",
        usage,
        blocks: [
          { type: "text", text: "let me look" },
          { type: "tool_call", id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a" }) },
        ],
      }),
      row(1, { type: "user_message", content: "read a" }),
      row(3, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "c1",
        name: "read_file",
        content: "contents",
        is_error: false,
      }),
    ]);
    // rows are sorted by seq regardless of input order
    expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "tool"]);
    const tool = blocks[2].tool!;
    expect(tool.callId).toBe("c1");
    expect(tool.status).toBe("done");
    expect(tool.content).toBe("contents");
    // stable keys derived from the source event's seq
    expect(blocks.map((b) => b.key)).toEqual(["1:0", "2:0", "2:1"]);
  });

  it("labels integration tools natively via the tool kind", () => {
    const blocks = eventsToBlocks([
      row(1, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "c1",
        name: "firecrawl_web_search",
        content: "results",
        is_error: false,
        kind: "web_search",
      } as ThreadEvent),
      row(2, {
        type: "tool_result",
        turn: 1,
        step: 2,
        call_id: "c2",
        name: "firecrawl_web_fetch",
        content: "page",
        is_error: false,
        kind: "web_browse",
      } as ThreadEvent),
      row(3, {
        type: "tool_result",
        turn: 1,
        step: 3,
        call_id: "c3",
        name: "int_searxng_web_search",
        content: "legacy name, meta kind only",
        is_error: false,
        meta: { card: "web", kind: "search", sources: [] },
      } as ThreadEvent),
    ]);
    expect(toolLabel(blocks[0].tool!)).toBe("Web search");
    expect(toolLabel(blocks[1].tool!)).toBe("Browse");
    // legacy pre-kind events fall back to the widget meta kind
    expect(toolLabel(blocks[2].tool!)).toBe("Web search");
  });

  it("keeps the connector slug in tool labels", () => {
    expect(toolDisplayName("atlassian_api")).toBe("atlassian api");
    expect(toolDisplayName("gitlab_api")).toBe("gitlab api");
    expect(toolDisplayName("int_github_api")).toBe("github api");
    expect(toolDisplayName("atlassian_jira_search")).toBe("atlassian jira search");
    // no namespace: bare name stands alone
    expect(toolDisplayName("api")).toBe("api");
  });

  const artifactMeta = {
    card: {
      card: "artifact",
      id: "11111111-1111-1111-1111-111111111111",
      filename: "report.xlsx",
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: 14821,
      path: ".guild/artifacts/chat-1/report.xlsx",
    },
  } as const;

  it("narrows well-formed artifact cards and rejects other card shapes", () => {
    const ok = artifactCardOf({ meta: artifactMeta });
    expect(ok).toEqual({
      card: "artifact",
      id: "11111111-1111-1111-1111-111111111111",
      filename: "report.xlsx",
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size_bytes: 14821,
      path: ".guild/artifacts/chat-1/report.xlsx",
    });
    // the task wire shape spells the discriminator `card`; `kind` also counts
    expect(artifactCardOf({ meta: { card: { kind: "artifact", id: "a", filename: "f", size_bytes: 1 } } })).not.toBeNull();
    // string cards (search/fetch/…) and malformed objects are not artifacts
    expect(artifactCardOf({ meta: { card: "web" } })).toBeNull();
    expect(artifactCardOf({ meta: { card: { card: "artifact", filename: "no-id" } } })).toBeNull();
    expect(artifactCardOf({ meta: { card: { card: "artifact", id: "a", filename: "", size_bytes: -1 } } })).toBeNull();
    expect(artifactCardOf({})).toBeNull();
  });

  it("propagates artifact card meta onto the tool block", () => {
    const blocks = eventsToBlocks([
      row(1, {
        type: "assistant_message",
        turn: 1,
        step: 1,
        model: "m",
        usage,
        blocks: [{ type: "tool_call", id: "c9", name: "api", arguments: "{}" }],
      }),
      row(2, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "c9",
        name: "api",
        content: "full result at .guild/artifacts/chat-1/report.xlsx",
        is_error: false,
        artifact_id: "11111111-1111-1111-1111-111111111111",
        meta: artifactMeta,
      } as ThreadEvent),
    ]);
    const tool = blocks[0].tool!;
    expect(tool.meta).toEqual(artifactMeta);
    const card = artifactCardOf(tool);
    expect(card?.filename).toBe("report.xlsx");
    expect(card?.size_bytes).toBe(14821);
  });

  it("renders an orphan tool_result instead of dropping it", () => {
    const blocks = eventsToBlocks([
      row(1, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "ghost",
        name: "execute",
        content: "out",
        is_error: true,
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool!.status).toBe("error");
    expect(blocks[0].tool!.name).toBe("execute");
  });

  it("carries compaction cards at their event position", () => {
    const blocks = eventsToBlocks([
      row(1, { type: "user_message", content: "hi" }),
      row(2, { type: "compaction", summary: "so far: hi" }),
      row(3, { type: "user_message", content: "more" }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "compaction", "user"]);
    expect(blocks[1].compaction!.summary).toBe("so far: hi");
  });
});

describe("accountDefaultLabel (unset chat trigger label)", () => {
  it("maps the account default onto the matching mode; unset = approve for me", () => {
    expect(accountDefaultLabel(null)).toBe("Approve for me");
    expect(accountDefaultLabel({} as ApprovalPolicy)).toBe("Approve for me");
    expect(accountDefaultLabel({ default: "ask" } as ApprovalPolicy)).toBe("Ask for approval");
    expect(accountDefaultLabel({ default: "allow" } as ApprovalPolicy)).toBe("Full access");
    expect(accountDefaultLabel({ default: "never" } as ApprovalPolicy)).toBe("Deny all");
  });
});

describe("approval upsert/resolve", () => {
  const card = (callId: string) => ({
    callId,
    name: "execute",
    args: "{}",
    status: "pending" as const,
  });

  it("upsert is idempotent per call", () => {
    let blocks: Block[] = [];
    blocks = upsertApproval(blocks, card("c1"));
    blocks = upsertApproval(blocks, card("c1"));
    blocks = upsertApproval(blocks, card("c2"));
    expect(blocks).toHaveLength(2);
    // the existing card's stable key survives the upsert
    expect(blocks[0].key).toBe("approval-c1");
  });

  it("resolve removes the matching card entirely", () => {
    let blocks: Block[] = [upsertApproval([], card("c1"))[0], upsertApproval([], card("c2"))[0]];
    blocks = resolveApproval(blocks, "c1", false, "no");
    // a decided approval is not conversation content — the card is gone;
    // the denial story lives on in the tool-result frame
    expect(blocks).toHaveLength(1);
    expect(blocks[0].approval!.callId).toBe("c2");
    // unknown call: no-op
    expect(resolveApproval(blocks, "other", true)).toEqual(blocks);
  });

  it("history derivation drops resolved approvals, keeps pending", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "go" }),
      row(1, { type: "approval_request", call_id: "c1", name: "execute", arguments: "{}" }),
      row(2, { type: "approval_decision", call_id: "c1", approved: true, reason: null }),
      row(3, { type: "approval_request", call_id: "c2", name: "execute", arguments: "{}" }),
      row(4, { type: "assistant_message", turn: 1, step: 0, blocks: [], usage, model: "m", interrupted: null }),
    ]);
    const approvals = blocks.filter((b) => b.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval!.callId).toBe("c2");
    expect(approvals[0].approval!.status).toBe("pending");
  });

  it("history derivation keeps expired approvals — no tool result tells their story", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "go" }),
      row(1, { type: "approval_request", call_id: "c1", name: "execute", arguments: "{}" }),
      row(2, {
        type: "approval_decision",
        call_id: "c1",
        approved: false,
        reason: "expired — no turn was waiting for this approval",
        expired: true,
      }),
    ]);
    const approvals = blocks.filter((b) => b.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval!.status).toBe("expired");
  });

  it("interrupted assistant events mark the last text block, not earlier ones", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "write a long essay" }),
      row(1, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        interrupted: true,
        blocks: [
          { type: "reasoning", text: "thinking…" },
          { type: "text", text: "partial answer so far" },
        ],
      }),
    ]);
    expect(blocks.filter((b) => b.kind === "text")).toHaveLength(1);
    expect(blocks.find((b) => b.kind === "text")!.interrupted).toBe(true);
    expect(blocks.find((b) => b.kind === "reasoning")!.interrupted).toBeUndefined();
  });

  it("a completed turn carries no interrupted marker", () => {
    const blocks = eventsToBlocks([
      row(0, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        interrupted: null,
        blocks: [{ type: "text", text: "done" }],
      }),
    ]);
    expect(blocks.find((b) => b.kind === "text")!.interrupted).toBeUndefined();
  });

  it("user turns strip the invoked-skills expansion and attachment blocks", () => {
    const blocks = eventsToBlocks([
      row(0, {
        type: "user_message",
        content:
          "run it\n\n---\nInvoked skills (follow their instructions):\n\n### Skill: deploy-check (/x/SKILL.md)\nbody…",
      }),
      row(1, {
        type: "user_message",
        content: "see this\n\n[Attachment: notes.txt (text/plain, 5 bytes)]\nhello",
      }),
    ]);
    expect(blocks.map((b) => (b as Block).text)).toEqual(["run it", "see this"]);
  });
});

describe("authoritative socket state", () => {
  it("overwrites reflected tokens instead of appending them during sync", () => {
    const state = { chat_id: "chat-1", seq: 2, events: [], text: "hello", thinking: "", generating: true };
    expect(threadStateBlocks(state).filter(b => b.kind === "text").map(b => b.text)).toEqual(["hello"]);
    expect(threadStateBlocks({ ...state, seq: 3, text: "hello!" }).map(b => b.text)).toEqual(["hello!"]);
  });
  it("renders a cross-tab user echo with no optimistic local send", () => {
    const state = { chat_id: "chat-1", seq: 3, events: [row(1, { type: "user_message", content: "other tab" })], text: "", thinking: "", generating: true };
    expect(threadStateBlocks(state).map(b => b.text)).toEqual(["other tab"]);
  });
  it("keeps the in-flight thinking block's key stable across publishes", () => {
    // The state feed republishes the whole thread (~100ms) while thinking
    // streams; the reasoning block is not a durable event yet, so its key
    // must not change between publishes — a changing key remounts the
    // frame and snaps an expanded block shut mid-click.
    const state = { chat_id: "chat-1", seq: 7, events: [row(1, { type: "user_message", content: "go" })], text: "", thinking: "part one", generating: true };
    const first = threadStateBlocks(state).find(b => b.kind === "reasoning");
    const second = threadStateBlocks({ ...state, seq: 8, thinking: "part one part two" }).find(b => b.kind === "reasoning");
    expect(first?.key).toBeTruthy();
    expect(second?.key).toBe(first?.key);
    expect(second?.reasoningText).toBe("part one part two");
  });
  it("replaces a stale generating overlay from the server list", () => {
    expect(statusFromThreads([{ id: "chat-1", generating: false, unread: false } as any])).toEqual({ "chat-1": { generating: false, working: false, unread: false, blocked: false } });
  });
});

describe("busyAfterThreadPush (a list push cannot un-busy an in-flight send)", () => {
  const row = (generating: boolean) => ({ id: "chat-1", title: "t", created_at: "x", generating }) as any;

  it("keeps busy while the send's HTTP round trip is in flight", () => {
    // Regression: a thread_list pushed in that window shows generating=false
    // (the flag is not set yet), which cleared the optimistic busy and let a
    // second send race the first.
    expect(busyAfterThreadPush([row(false)], "chat-1", true)).toBe(true);
    expect(busyAfterThreadPush([], "chat-1", true)).toBe(true);
  });

  it("follows the server's generating flag otherwise", () => {
    expect(busyAfterThreadPush([row(true)], "chat-1", false)).toBe(true);
    expect(busyAfterThreadPush([row(false)], "chat-1", false)).toBe(false);
    expect(busyAfterThreadPush([row(false)], null, false)).toBe(false);
  });

  it("keeps a child thread's live status when the list has no row", () => {
    // Regression: child threads never appear in thread_list. Treating the
    // absent row as generating=false cleared the Working indicator on every
    // sidebar push while the child's run was still live.
    expect(busyAfterThreadPush([], "child-1", false, true)).toBe(true);
    expect(busyAfterThreadPush([row(false)], "child-1", false, true)).toBe(true);
    expect(busyAfterThreadPush([], "child-1", false, false)).toBe(false);
  });

  it("never busies the new-chat composer off an in-flight first send", () => {
    // The first send's pending state is the dedicated pending-submit
    // spinner; busy here feeds stopMode, and a Stop button for a turn that
    // does not exist yet is a lie. A list push during creation must not
    // busy the scratch composer.
    expect(busyAfterThreadPush([row(false)], null, true)).toBe(false);
    expect(busyAfterThreadPush([], null, true)).toBe(false);
  });
});

describe("sendButtonState (pending submit holds the button until the turn exists)", () => {
  const base = { hasContent: true, hasModel: true, generating: false, stopping: false, submitting: false };

  it("send when idle with content, disabled without", () => {
    expect(sendButtonState(base)).toBe("send");
    expect(sendButtonState({ ...base, hasContent: false })).toBe("send");
  });

  it("a first-send submit in flight shows the spinner, not Stop", () => {
    // Regression: the optimistic busy fed stopMode and offered Stop for a
    // turn that had not started — the chat does not even exist yet.
    expect(sendButtonState({ ...base, hasContent: false, submitting: true })).toBe("pending");
  });

  it("an existing turn outranks the pending submit; the stop click refines Stop", () => {
    expect(sendButtonState({ ...base, hasContent: false, generating: true, submitting: true })).toBe("stop");
    expect(sendButtonState({ ...base, hasContent: false, generating: true, stopping: true })).toBe("stopping");
  });

  it("a chat that is only working keeps the send button", () => {
    // working covers a running descendant, not this chat's own turn: the
    // composer must stay in send mode and never offer Stop.
    expect(sendButtonState({ ...base, generating: false })).toBe("send");
  });
});

describe("pruneStopping (a stop click lifts when the chat's own generating settles)", () => {
  const status = (generating: boolean) => ({ generating, unread: false });

  it("keeps the flag while every server-truth source still says generating (or is silent)", () => {
    // Regression: the stop click flagged the chat but nothing lifted it —
    // the button stayed in its pre-click state for the whole epilogue.
    expect(pruneStopping({ "chat-1": true }, { "chat-1": status(true) }, null)).toBeNull();
    // No evidence is no clearance: unknown chat keeps the flag.
    expect(pruneStopping({ "chat-1": true }, {}, null)).toBeNull();
    expect(pruneStopping({ "chat-1": true }, {}, [ { id: "chat-2" } as any ])).toBeNull();
  });

  it("lifts when the thread-state frame or the pushed list says false", () => {
    const viaFrame = pruneStopping({ "chat-1": true }, { "chat-1": status(false) }, null);
    expect(viaFrame).toEqual({});
    const viaList = pruneStopping(
      { "chat-1": true, "chat-2": true },
      {},
      [ { id: "chat-1", generating: false }, { id: "chat-2", generating: true } ] as any,
    );
    expect(viaList).toEqual({ "chat-2": true });
  });
});

describe("offlineMachine (offline bound-machine banner)", () => {
  const base = { id: "chat-1", title: "t", created_at: "x" } as any;
  const bound = (
    machine_id: string,
    _connected: boolean | undefined,
    machine_label?: string,
    project_id: string | null = "p1",
  ) => ({ ...base, machine_id, machine_label, project_id } as any);
  const machines = (connected: boolean, name = "WORKSTATION", machine_id = "m1") =>
    [{ machine_id, name, connected }] as any;

  it("shows the label when the open chat's project-bound machine is offline", () => {
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], machines(false), "chat-1", true, "local")).toEqual({ label: "WORKSTATION" });
    // no label: fall back to the machine name, then the raw machine id
    expect(offlineMachine([bound("m1", false)], machines(false), "chat-1", true, "local")).toEqual({ label: "WORKSTATION" });
    expect(offlineMachine([bound("m1", false)], [{ machine_id: "m1", name: "", connected: false }] as any, "chat-1", true, "local")).toEqual({ label: "m1" });
  });

  it("stays hidden for unbound chats, machine-bound-without-project rows, and online/unknown machines", () => {
    expect(offlineMachine([base], machines(false), "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION", null)], machines(false), "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], machines(true), "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], [], "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], null, "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], machines(false), null, true, "local")).toBeNull();
  });

  it("skips the local machine on desktop, but banners every project binding on web", () => {
    expect(offlineMachine([bound("local", false, "SELF")], machines(false, "SELF", "local"), "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("local", false, "SELF")], machines(false, "SELF", "local"), "chat-1", false, undefined)).toEqual({ label: "SELF" });
  });
});

describe("pending send reconciliation", () => {
  it("keeps the optimistic sending marker when resync history has no message yet", () => {
    const pending = {
      chatId: "chat-1",
      text: "still sending",
      key: "pending-1",
      sentAt: Date.parse("2026-09-16T00:00:00.000Z"),
    };
    expect(reconcilePendingSend([], [], pending)).toEqual([
      { kind: "user", text: "still sending", key: "pending-1", pending: true, eventId: "pending-1", ts: expect.any(String) },
    ]);
  });

  it("settles only the matching server echo, independent of clock skew", () => {
    const pending = { chatId: "chat-1", text: "hello", key: "e1", sentAt: 9999999999999 };
    const rows = [row(1, { type: "user_message", content: "hello" })];
    const result = reconcilePendingSend(rows, eventsToBlocks(rows), pending);
    expect(result.some((block) => block.pending)).toBe(false);
    const otherTab = [row(2, { type: "user_message", content: "hello" })];
    expect(reconcilePendingSend(otherTab, eventsToBlocks(otherTab), pending).some(block => block.pending)).toBe(true);
  });
});

describe("parseSearchResults", () => {
  it("parses the numbered fallback format", () => {
    const out = parseSearchResults(
      ["1. First Result", "https://a.example/x", "first snippet", "2. Second", "https://b.example/"].join("\n"),
    );
    expect(out).toEqual([
      { url: "https://a.example/x", title: "First Result", snippet: "first snippet" },
      { url: "https://b.example/", title: "Second" },
    ]);
  });

  it("drops entries without a URL", () => {
    expect(parseSearchResults("1. Only a title\nno url here")).toEqual([]);
  });
});

describe("replayFrom", () => {
  it("keeps the whole list before the turn's first tool completes", () => {
    const frames = [
      { type: "thinking_delta", content: "hmm" },
      { type: "delta", content: "Hi" },
    ];
    expect(replayFrom(frames)).toEqual(frames);
  });

  it("drops everything up to the last completed tool — that is persisted", () => {
    const tail = [
      { type: "thinking_delta", content: "next step" },
      { type: "delta", content: "Working on it" },
    ];
    const frames = [
      { type: "delta", content: "step one text" },
      { type: "tool_started", call_id: "a", name: "execute" },
      { type: "tool_completed", call_id: "a", content: "ok" },
      ...tail,
    ];
    expect(replayFrom(frames)).toEqual(tail);
  });

  it("uses the LAST tool_completed, keeping a later suspended call visible", () => {
    const frames = [
      { type: "tool_started", call_id: "a" },
      { type: "tool_completed", call_id: "a" },
      { type: "tool_started", call_id: "b" },
    ];
    expect(replayFrom(frames)).toEqual([{ type: "tool_started", call_id: "b" }]);
  });

  it("returns an empty replay when the last frame is a completed tool", () => {
    const frames = [
      { type: "delta", content: "text" },
      { type: "tool_started", call_id: "a" },
      { type: "tool_completed", call_id: "a" },
    ];
    expect(replayFrom(frames)).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2", "0.10.1")).toBeLessThan(0);
    // missing segments count as 0
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("mentionCandidates (slash autocomplete pool)", () => {
  const builtins = [
    { name: "compact", description: "Compact this thread" },
    { name: "clear", description: "another command" },
  ];
  const skills = [
    { name: "deploy-check", description: "verify a deploy", disabled: false },
    { name: "compactor", description: "dup-ish prefix", disabled: false },
    { name: "hidden", description: "disabled skill", disabled: true },
  ];

  it("lists builtins first, then enabled skills, prefix-filtered and capped", () => {
    expect(mentionCandidates(builtins, skills, "").map((c) => c.name)).toEqual([
      "compact",
      "clear",
      "deploy-check",
      "compactor",
    ]);
    expect(mentionCandidates(builtins, skills, "comp").map((c) => c.name)).toEqual([
      "compact",
      "compactor",
    ]);
    expect(mentionCandidates(builtins, skills, "c").length).toBe(3); // cap at 6 not hit
  });

  it("works without local skills (browser mode) and tags builtins", () => {
    const res = mentionCandidates(builtins, null, "");
    expect(res.map((c) => c.name)).toEqual(["compact", "clear"]);
    expect(res.every((c) => c.builtin)).toBe(true);
    const mixed = mentionCandidates(builtins, skills, "deploy");
    expect(mixed[0].builtin).toBe(false);
  });
});

describe("composerSkills (local + installed org pool, spec §2.3)", () => {
  const local = [
    { name: "local-a", description: "a local skill", disabled: false },
    { name: "dup", description: "local wins", disabled: false },
  ];
  const installs = [
    { slug: "org-deploy", pinned_version: "v2" },
    { slug: "dup", pinned_version: "v1" }, // also local: folds into the local row
  ];

  it("org group carries only installed org skills; local rows win duplicates", () => {
    const pool = composerSkills(local, installs);
    const orgGroup = pool.filter((s) => s.org);
    expect(orgGroup.map((s) => s.name)).toEqual(["org-deploy"]); // `dup` is listed locally — no second entry
    expect(pool.map((s) => s.name)).toEqual(["local-a", "dup", "org-deploy"]);
  });
  it("uninstalled org skills never enter (they are not in the installs list)", () => {
    const pool = composerSkills(local, [{ slug: "org-deploy", pinned_version: "v2" }]);
    expect(pool.some((s) => s.name === "uninstalled-org-skill" || s.org === undefined && s.name.startsWith("uninstalled"))).toBe(false);
    expect(pool.filter((s) => s.org)).toHaveLength(1);
  });
  it("works with either half absent", () => {
    expect(composerSkills(null, installs).map((s) => s.name)).toEqual(["org-deploy", "dup"]);
    expect(composerSkills(local, null)).toEqual(local);
    expect(composerSkills(null, null)).toEqual([]);
  });
  it("org entries ride the /-autocomplete pool", () => {
    const pool = composerSkills(local, installs);
    const candidates = mentionCandidates([{ name: "compact", description: "c" }], pool, "");
    expect(candidates.map((c) => c.name)).toEqual(["compact", "local-a", "dup", "org-deploy"]);
    expect(candidates.find((c) => c.name === "org-deploy")?.org).toBe(true);
    expect(candidates.find((c) => c.name === "local-a")?.org).toBe(false);
  });
});

describe("tabPaneLayout (route → sidebar/pane layout)", () => {
  const route = (tab: ChatRoute["tab"], skills: ChatRoute["skills"] = null, agents: ChatRoute["agents"] = null) =>
    ({ tab, skills, agents });

  it("the skills page is a full-page main-pane swap with NO sidebar aside", () => {
    expect(tabPaneLayout(route("chats", { view: "catalog", slug: null, editor: null }), false)).toEqual({
      aside: false,
      mainPane: "skillsPage",
      expandsPanel: false,
    });
  });

  it("the agents surface is a full-page main-pane swap too", () => {
    expect(tabPaneLayout(route("chats", null, { view: "directory" }), false)).toEqual({
      aside: false,
      mainPane: "agentsPage",
      expandsPanel: false,
    });
  });

  it("the other desktop tabs keep the panel sidebar and the chat thread", () => {
    for (const tab of ["chats", "work", "settings"] as ChatRoute["tab"][]) {
      expect(tabPaneLayout(route(tab), false)).toEqual({
        aside: true,
        mainPane: tab === "settings" ? "settingsPage" : "chat",
        expandsPanel: true,
      });
    }
  });

  it("mobile keeps the chats-only drawer behavior unchanged", () => {
    for (const tab of ["chats", "work", "settings"] as ChatRoute["tab"][]) {
      expect(tabPaneLayout(route(tab), true).mainPane).toBe("chat");
      expect(tabPaneLayout(route(tab), true).aside).toBe(false);
    }
  });
});

describe("viewEntries (collapsed work runs)", () => {
  const tool = (n: number): Block => ({
    kind: "tool",
    text: "",
    key: `t${n}`,
    tool: { callId: `c${n}`, name: "sh", args: "", executor: "server", status: "done" },
  });
  const text = (n: number): Block => ({ kind: "text", text: `text${n}`, key: `x${n}` });
  const user: Block = { kind: "user", text: "go", key: "u", ts: "2026-10-15T12:00:00.000Z" };
  const shape = (blocks: Block[]) =>
    viewEntries(blocks).map((e) =>
      e.kind === "work" ? `work(${e.run.map((b) => b.key).join(",")})` : e.b.key,
    );

  it("collapses a contiguous run into one entry sitting where the run was", () => {
    const blocks = [user, tool(1), tool(2), text(3), tool(4), tool(5), text(6)];
    expect(shape(blocks)).toEqual(["u", "work(t1,t2)", "x3", "work(t4,t5)", "x6"]);
  });

  it("never leaves a work entry trailing the text that followed its run", () => {
    const blocks = [user, tool(1), text(2), tool(3), text(4)];
    const entries = viewEntries(blocks);
    expect(entries[entries.length - 1]).toMatchObject({ kind: "plain", b: { key: "x4" } });
  });

  it("anchors every run to the turn's user message", () => {
    const blocks = [user, tool(1), text(2), tool(3)];
    const runs = viewEntries(blocks).filter((e) => e.kind === "work");
    expect(runs.map((r) => r.kind === "work" && r.turnStart)).toEqual([
      "2026-10-15T12:00:00.000Z",
      "2026-10-15T12:00:00.000Z",
    ]);
  });

  it("puts a subagent record inside the work run", () => {
    const child: Block = {
      kind: "child_spawn",
      text: "",
      key: "c1",
      ts: "2026-10-15T12:00:04.000Z",
      childSpawn: {
        threadId: "child-thread",
        agentName: "Researcher",
        startedAt: "2026-10-15T12:00:00.000Z",
      },
    };
    const blocks = [user, tool(1), child, text(2)];
    expect(shape(blocks)).toEqual(["u", "work(t1,c1)", "x2"]);
  });
});

describe("workRunLabel (worked-for entry)", () => {
  const run = (start?: string, end?: string): Block[] => [
    {
      kind: "tool",
      text: "",
      key: "k",
      tool: { callId: "c", name: "sh", args: "", executor: "server", status: "done", ts: start, endTs: end },
    },
  ];

  it("a completed run under one second still gets a label for its details", () => {
    expect(workRunLabel(run("2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.500Z"), false, false, 0)).toBe("Agent worked");
    expect(workRunLabel(run("2026-10-15T12:00:00.000Z", "2026-10-15T12:00:00.000Z"), false, false, 0)).toBe("Agent worked");
  });

  it("a completed run without stamps still gets a label; longer runs spell the duration", () => {
    expect(workRunLabel(run(undefined, undefined), false, false, 0)).toBe("Agent worked");
    expect(workRunLabel(run("2026-10-15T12:00:00.000Z", "2026-10-15T12:00:07.000Z"), false, false, 0)).toBe(
      "Agent worked for 7 seconds",
    );
    expect(workRunLabel(run("2026-10-15T12:00:00.000Z", "2026-10-15T12:01:23.000Z"), false, false, 0)).toBe(
      "Agent worked for 1m 23s",
    );
  });

  it("live states always render, even before any stamp exists", () => {
    expect(workRunLabel(run(undefined, undefined), true, false, 0)).toBe("Agent is working");
    expect(workRunLabel(run("2026-10-15T12:00:00.000Z", undefined), true, false, Date.parse("2026-10-15T12:00:05.000Z"))).toBe(
      "Agent is working 5s",
    );
    expect(workRunLabel(run(undefined, undefined), true, true, 0)).toBe("Agent is stopping");
  });

  it("the live clock anchors to the turn start when given (no per-step resets)", () => {
    // Run opened 3s ago, but the turn began 12s ago (previous steps in
    // between): the live label counts the whole turn, not this run.
    expect(
      workRunLabel(
        run("2026-10-15T12:00:09.000Z", undefined),
        true,
        false,
        Date.parse("2026-10-15T12:00:12.000Z"),
        "2026-10-15T12:00:00.000Z",
      ),
    ).toBe("Agent is working 12s");
    // The settled label ignores the turn anchor — it spells this run's own
    // open-to-end duration.
    expect(
      workRunLabel(
        run("2026-10-15T12:00:09.000Z", "2026-10-15T12:00:12.000Z"),
        false,
        false,
        0,
        "2026-10-15T12:00:00.000Z",
      ),
    ).toBe("Agent worked for 3 seconds");
  });
});

describe("isImeEnter", () => {
  it("treats an IME commit as not-a-submit", () => {
    // A candidate is committed with Enter; both signals mean "composing".
    expect(isImeEnter({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeEnter({ keyCode: 229 })).toBe(true);
    expect(isImeEnter({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isImeEnter({})).toBe(false);
  });
});

describe("child thread navigation", () => {
  it("opens a child at the canonical thread address and parses it back", () => {
    const path = chatRoutePath("child-chat", null, null);
    expect(path).toBe("/thread/child-chat");
    expect(parseChatRoute(path).chatId).toBe("child-chat");
    expect(parseChatRoute(path).agents).toBeNull();
  });

});
