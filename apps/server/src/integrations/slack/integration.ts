import { slackBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS } from "../probe.js";
import { fetchTimeout, readBodyCapped } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { slackExecute } from "./execute.js";
import { apiTool } from "../api-tool.js";

function spec(name: string, description: string, properties: JsonObject) {
  return {
    name,
    class: "read" as const,
    description,
    parameters: { type: "object", properties },
  };
}

const plugin: IntegrationPlugin = {
  manifest: {
    name: "slack",
    title: "Slack",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Slack: list channels and users, read channel history, post messages",
    description:
      "Adds Slack to chats. List the channels the bot can see, read the history of " +
      "one channel, list workspace users, and post a message.\n\n" +
      "Access uses one bot token. The bot must be a member of a private channel " +
      "before it can read that channel.",
    docs_url: "https://api.slack.com/methods",
    categories: ["messaging"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "API URL",
        required: false,
        default: "https://slack.com/api",
        help: "Override only for a Slack API proxy",
        placeholder: null,
      },
      {
        name: "bot_token",
        kind: "secret",
        label: "Bot token",
        required: true,
        default: null,
        help: null,
        placeholder: "xoxb-…",
      },
    ],
    tools: [
      spec("conversations_list", "List Slack channels (public and private the bot can see).", {
        limit: { type: "number", description: "1-200, default 200" },
        cursor: { type: "string", description: "Pagination cursor from a previous page" },
      }),
      spec("conversations_history", "Read the message history of one channel by ID.", {
        channel: { type: "string", description: "Channel ID, e.g. C0123456789" },
        limit: { type: "number", description: "1-200 messages, default 200" },
        cursor: { type: "string", description: "Pagination cursor from a previous page" },
      }),
      spec("users_list", "List Slack users in the workspace.", {
        limit: { type: "number", description: "1-200, default 200" },
        cursor: { type: "string", description: "Pagination cursor from a previous page" },
      }),
      {
        name: "post_message",
        class: "write",
        description: "Post a message to a Slack channel through chat.postMessage.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID or name, e.g. C0123456789 or #general" },
            text: { type: "string", description: "Message text (plain text or Slack mrkdwn)" },
          },
        },
      },
      apiTool("Slack Web API"),
    ],
  },
  validate(config: JsonObject) {
    if ("base_url" in config && typeof config["base_url"] !== "string") {
      throw new Error("slack config base_url must be a string");
    }
    slackBaseUrl(config);
  },
  async testConnection(config: JsonObject, secrets) {
    if ("base_url" in config && typeof config["base_url"] !== "string") {
      throw new Error("slack config base_url must be a string");
    }
    const base = slackBaseUrl(config);
    const token = secret(secrets, "bot_token");
    // Slack answers HTTP 200 with {"ok": false, ...} for an invalid or
    // revoked token: the body verdict decides, not the status.
    let res: Response;
    try {
      res = await fetch(
        `${base}/auth.test`,
        fetchTimeout(PROBE_TIMEOUT_MS, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    } catch (error) {
      const cause =
        error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new Error(`slack unreachable: ${cause}`);
    }
    let body: JsonObject = {};
    try {
      body = JSON.parse((await readBodyCapped(res, 64 * 1024)).text) as JsonObject;
    } catch {
      body = {};
    }
    if (res.ok && body["ok"] === true) return;
    if (res.ok) {
      throw new Error(`slack rejected the token (${typeof body["error"] === "string" ? body["error"] : "ok=false"})`);
    }
    throw new Error(`slack rejected the connection (${res.status} ${res.statusText})`);
  },
  execute: slackExecute,
};

export default plugin;
