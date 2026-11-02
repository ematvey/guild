// The thread-history tools: `thread_history` (the current conversation's
// chat, cursor-paginated) and `thread_search` (text search across every chat
// the chat owner can list, the same org+user scope `ChatStore.listChats`
// uses). Both are script-only tools (`callers: ["tools"]`): the model reaches
// them through codemode, and the QuickJS VM holds no state between scripts —
// so every fetch must be self-contained and bounded. The DB-load guards:
// SQL-side LIMIT with hard clamps, cursor pagination instead of offsets,
// per-event text caps, and snippet-only search hits (never whole messages).

import { Type } from "typebox";
import {
  defineTool,
  type ConversationId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ChatStore } from "../platform/store/chats.js";
import type { ThreadStore } from "../platform/store/thread.js";

/** Chats read their own history; the caller resolves chat→conversation. */
export interface ThreadHistoryDeps {
  chats: Pick<ChatStore, "sameOwner">;
  threads: Pick<ThreadStore, "messagePage" | "searchOwnerMessages">;
  chatOfConversation(conversationId: ConversationId): Promise<string | null>;
}

const DEFAULT_PAGE = 40;
const MAX_PAGE = 100;
const MAX_EVENT_CHARS = 4_000;
const DEFAULT_HITS = 15;
const MAX_HITS = 30;
const SNIPPET_RADIUS = 90;
const MIN_QUERY_CHARS = 2;

const eventShape = Type.Object({
  seq: Type.Number(),
  type: Type.String(),
  ts: Type.String(),
  text: Type.String(),
});

/** The two tools' shared output schema pieces (structuredOutput for scripts). */
const historyOutput = Type.Object({
  events: Type.Array(eventShape),
  /** Pass as `beforeSeq` to fetch the next (older) page; null at the start. */
  nextBeforeSeq: Type.Union([Type.Number(), Type.Null()]),
});

const searchOutput = Type.Object({
  hits: Type.Array(
    Type.Object({
      chatId: Type.String(),
      chatTitle: Type.Union([Type.String(), Type.Null()]),
      seq: Type.Number(),
      type: Type.String(),
      ts: Type.String(),
      snippet: Type.String(),
    }),
  ),
  truncated: Type.Boolean(),
});

/** Model-visible text of one thread event: user/system content, the
 *  assistant message's text blocks (reasoning and tool_call blocks dropped),
 *  or a tool result's content. Empty string when the event carries none. */
function eventText(type: string, payload: Record<string, unknown>): string {
  if (type === "user_message" || type === "system_message" || type === "tool_result") {
    return typeof payload.content === "string" ? payload.content : "";
  }
  if (type === "assistant_message" && Array.isArray(payload.blocks)) {
    return (payload.blocks as { type?: string; text?: string }[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function clip(text: string, max = MAX_EVENT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** First match with context, or the head of the text when the match sits in
 *  an unsearched field (the SQL prefilter matches payload::text, which also
 *  covers attachments and block JSON). */
function snippetOf(text: string, lowerQuery: string): string {
  if (text === "") return "";
  const at = text.toLowerCase().indexOf(lowerQuery);
  if (at < 0) return clip(text, SNIPPET_RADIUS * 2);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + lowerQuery.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Error result on the output channel (structuredOutput is not allowed with isError). */
const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

export function createThreadHistoryTools(deps: ThreadHistoryDeps): ToolRegistration[] {
  const history = defineTool({
    name: "thread_history",
    description:
      "Read this chat's past messages, newest first. One page per call — pass `nextBeforeSeq` from the previous " +
      "result as `beforeSeq` to page further back. Filter by `role` and/or `text` server-side instead of pulling " +
      "pages to scan them in the script.",
    parameters: Type.Object({
      chatId: Type.Optional(
        Type.String({
          description:
            "Read another chat's thread (a `thread_search` hit's chatId). The chat must belong to this conversation's " +
            "owner — a foreign chat resolves to an error, never to its messages.",
        }),
      ),
      role: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("assistant")], {
          description: "Only messages of this role",
        }),
      ),
      text: Type.Optional(Type.String({ description: "Only messages containing this text (case-insensitive)" })),
      beforeSeq: Type.Optional(
        Type.Number({
          description: "Page cursor: events older than this seq (from the previous page's nextBeforeSeq)",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: `Page size, 1–${MAX_PAGE} (default ${DEFAULT_PAGE})` })),
    }),
    structuredOutputSchema: historyOutput,
    replay: "safe",
    callers: ["tools"],
    outputLimits: { maxBytes: 64 * 1024 },
    execute: async (args, api) => {
      const ownChatId = await deps.chatOfConversation(api.conversationId);
      if (ownChatId === null) return textErr("not_found");
      let chatId = ownChatId;
      if (args.chatId !== undefined && args.chatId !== ownChatId) {
        // Cross-chat drill-in: the target must sit in the same (org, user)
        // scope the owner's chat list shows — anything else errors without
        // leaking that the chat exists.
        if (!(await deps.chats.sameOwner(ownChatId, args.chatId))) return textErr("not_found");
        chatId = args.chatId;
      }
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_PAGE)), MAX_PAGE);
      const { rows, more } = await deps.threads.messagePage(chatId, {
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }),
        limit,
      });
      const events = rows.map((row) => ({
        seq: row.seq,
        type: row.type,
        ts: row.created_at.toISOString(),
        text: clip(eventText(row.type, row.payload)),
      }));
      return {
        structuredOutput: { events, nextBeforeSeq: more ? events[events.length - 1]!.seq : null },
      };
    },
  });

  const search = defineTool({
    name: "thread_search",
    description:
      "Search the chat owner's other chats' messages by text (this chat included). Returns snippet hits with their " +
      "chat id and seq — drill into a hit with `thread_history` on that chat (the hit's seq bounds the page). " +
      "Server-side, permission-scoped: only chats the owner could list.",
    parameters: Type.Object({
      query: Type.String({ description: "Text to look for (case-insensitive substring, 2+ chars)" }),
      limit: Type.Optional(Type.Number({ description: `Max hits, 1–${MAX_HITS} (default ${DEFAULT_HITS})` })),
    }),
    structuredOutputSchema: searchOutput,
    replay: "safe",
    callers: ["tools"],
    outputLimits: { maxBytes: 32 * 1024 },
    execute: async (args, api) => {
      const query = args.query.trim();
      if (query.length < MIN_QUERY_CHARS) {
        return {
          isError: true,
          output: [{ type: "text", text: `query needs at least ${MIN_QUERY_CHARS} characters` }],
        };
      }
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_HITS)), MAX_HITS);
      // The tool binds the requesting conversation's chat owner: the same
      // (org_id, user_id) scope ChatStore.listChats applies, so a hit is
      // always a thread the user can open.
      const ownChatId = await deps.chatOfConversation(api.conversationId);
      if (ownChatId === null) return { structuredOutput: { hits: [], truncated: false } };
      const { rows, more: truncated } = await deps.threads.searchOwnerMessages(ownChatId, query, limit);
      const lower = query.toLowerCase();
      const hits = rows.map((row) => ({
        chatId: row.chat_id,
        chatTitle: row.title,
        seq: row.seq,
        type: row.type,
        ts: row.created_at.toISOString(),
        snippet: snippetOf(clip(eventText(row.type, row.payload), 8 * MAX_EVENT_CHARS), lower),
      }));
      return { structuredOutput: { hits, truncated } };
    },
  });

  return [history, search];
}
