import {
  LIST_TIMEOUT_MS,
  VENDOR_API_MAX_CHARS,
  secret,
  requestJson,
  clampNumber,
  callVendorApi,
  slackBaseUrl,
  type JsonRequestErrors,
} from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

// ---------- slack ----------

const SLACK_ERRORS: JsonRequestErrors = {
  unreachable: (cause) => `slack unreachable: ${cause}`,
  unreadable: () => "slack returned bad json",
  status: (status) => `slack returned ${status}`,
  badJson: () => "slack returned bad json",
};

async function slackApi(url: string, init: RequestInit): Promise<JsonObject> {
  const body = await requestJson(url, init, LIST_TIMEOUT_MS, SLACK_ERRORS);
  if (body["ok"] !== true) {
    throw new Error(`slack api error: ${typeof body["error"] === "string" ? body["error"] : "unknown"}`);
  }
  return body;
}

async function slackGet(
  base: string,
  botToken: string,
  endpoint: string,
  query: [string, string][],
): Promise<JsonObject> {
  const url = new URL(`${base}/${endpoint}`);
  for (const [k, v] of query) url.searchParams.set(k, v);
  return slackApi(url.toString(), { method: "GET", headers: { authorization: `Bearer ${botToken}` } });
}

async function slackPost(base: string, botToken: string, endpoint: string, body: JsonObject): Promise<JsonObject> {
  return slackApi(`${base}/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function slackJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function slackExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  const base = slackBaseUrl(config);
  if (tool === "api") {
    const token = secret(secrets, "bot_token");
    return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "conversations_list": {
      const token = secret(secrets, "bot_token");
      const query: [string, string][] = [
        ["limit", String(clampNumber(args, "limit", 200, 200))],
        ["types", "public_channel,private_channel"],
      ];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      const body = await slackGet(base, token, "conversations.list", query);
      const channels = (Array.isArray(body["channels"]) ? (body["channels"] as JsonObject[]) : []).map((c) => ({
        id: c["id"] ?? null,
        name: c["name"] ?? null,
        is_private: c["is_private"] ?? null,
        is_member: c["is_member"] ?? null,
        topic: ((c["topic"] ?? {}) as JsonObject)["value"] ?? null,
      }));
      // The cursor and has_more ride the content too: the model sees
      // content only, and a multi-page list it cannot page is a silently
      // truncated one.
      const metadata = (body["response_metadata"] ?? {}) as JsonObject;
      return {
        content: slackJsonText({ channels, next_cursor: metadata["next_cursor"] ?? null }),
        meta: { response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "conversations_history": {
      const token = secret(secrets, "bot_token");
      const channel = args["channel"];
      if (typeof channel !== "string") throw new Error("conversations_history requires channel");
      const query: [string, string][] = [
        ["channel", channel],
        ["limit", String(clampNumber(args, "limit", 200, 200))],
      ];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      // The bot can enumerate public channels it has not joined
      // (conversations.list shows them workspace-wide), but
      // conversations.history requires membership. On not_in_channel,
      // self-join the public channel and retry once — the join is visible
      // in the workspace (the bot appears in the member list).
      let body: JsonObject;
      try {
        body = await slackGet(base, token, "conversations.history", query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("slack api error: not_in_channel")) throw error;
        try {
          await slackPost(base, token, "conversations.join", { channel });
        } catch (joinError) {
          const joinMessage = joinError instanceof Error ? joinError.message : String(joinError);
          throw new Error(`${message} (join attempt failed: ${joinMessage})`);
        }
        try {
          body = await slackGet(base, token, "conversations.history", query);
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`${message} (joined, retry failed: ${retryMessage})`);
        }
      }
      const messages = (Array.isArray(body["messages"]) ? (body["messages"] as JsonObject[]) : []).map((m) => ({
        ts: m["ts"] ?? null,
        user: m["user"] ?? null,
        text: m["text"] ?? null,
      }));
      const metadata = (body["response_metadata"] ?? {}) as JsonObject;
      return {
        content: slackJsonText({
          messages,
          has_more: body["has_more"] === true,
          next_cursor: metadata["next_cursor"] ?? null,
        }),
        meta: { has_more: body["has_more"] === true, response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "users_list": {
      const token = secret(secrets, "bot_token");
      const query: [string, string][] = [["limit", String(clampNumber(args, "limit", 200, 200))]];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      const body = await slackGet(base, token, "users.list", query);
      const users = (Array.isArray(body["members"]) ? (body["members"] as JsonObject[]) : []).map((u) => ({
        id: u["id"] ?? null,
        name: u["name"] ?? null,
        real_name: u["real_name"] ?? null,
        is_bot: u["is_bot"] ?? null,
      }));
      // The cursor rides the content too (the model sees content only — a
      // multi-page list it cannot page is a silently truncated one).
      const metadata = (body["response_metadata"] ?? {}) as JsonObject;
      return {
        content: slackJsonText({ users, next_cursor: metadata["next_cursor"] ?? null }),
        meta: { response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "post_message": {
      const token = secret(secrets, "bot_token");
      const channel = args["channel"];
      if (typeof channel !== "string") throw new Error("post_message requires channel");
      const text = args["text"];
      if (typeof text !== "string") throw new Error("post_message requires text");
      const body = await slackPost(base, token, "chat.postMessage", { channel, text });
      return { content: slackJsonText({ channel: body["channel"] ?? null, ts: body["ts"] ?? null }) };
    }
    default:
      throw new Error(`slack integration has no tool ${tool}`);
  }
}
