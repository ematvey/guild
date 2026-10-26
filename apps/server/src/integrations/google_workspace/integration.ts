import { googleAccessTokenFor } from "./execute.js";
import type { Json } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { googleWorkspaceExecute } from "./execute.js";
import { apiTool } from "../api-tool.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "google_workspace",
    title: "Google Workspace",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Read-only Google Workspace tools: Gmail, Calendar, Drive, Admin Directory",
    description:
      "Adds Google Workspace to chats: search Gmail, read a message and its " +
      "attachments, list calendar events, search Drive, and list directory users.\n\n" +
      "Access uses one service account with domain-wide delegation. Every call " +
      "acts as the chat's user through the token `sub` claim, so a chat reads only " +
      "the mail and files that user can already open.",
    docs_url: "https://developers.google.com/workspace",
    categories: ["messaging", "docs"],
    traits: {},
    auth_kind: "org_secret_impersonated",
    identity_key: "email",
    fields: [
      {
        name: "api_base",
        kind: "string",
        label: "API base",
        required: false,
        default: "https://www.googleapis.com",
        help: "Override only for a Google API proxy",
        placeholder: null,
      },
      {
        name: "token_url",
        kind: "string",
        label: "Token URL",
        required: false,
        default: "https://oauth2.googleapis.com/token",
        help: "Override only for a Google API proxy",
        placeholder: null,
      },
      {
        name: "admin_email",
        kind: "string",
        label: "Admin email",
        required: true,
        default: null,
        help: "Workspace admin the service account acts as by default",
        placeholder: "admin@yourorg.com",
      },
      {
        name: "service_account_json",
        kind: "secret",
        label: "Service account JSON",
        required: true,
        default: null,
        help: null,
        placeholder: "{ … }",
      },
    ],
    tools: [
      {
        name: "gmail_search",
        class: "read",
        description: "Search Gmail and return matching message ids (Gmail query syntax).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query, e.g. 'from:alice has:attachment'" },
            max_results: { type: "number", description: "1-25, default 10" },
          },
          required: ["query"],
        },
      },
      {
        name: "gmail_get_message",
        class: "read",
        description:
          "Fetch one Gmail message: headers, text body, and the list of attachment parts (filename, mime, attachment id).",
        parameters: {
          type: "object",
          properties: { message_id: { type: "string" } },
          required: ["message_id"],
        },
      },
      {
        name: "gmail_get_attachment",
        class: "read",
        description:
          "Fetch one Gmail attachment as a downloadable file artifact. Get the attachment id from gmail_get_message's attachment list.",
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "string" },
            attachment_id: { type: "string" },
            filename: { type: "string", description: "Override the materialized filename (optional)" },
          },
          required: ["message_id", "attachment_id"],
        },
      },
      {
        name: "calendar_list_events",
        class: "read",
        description: "List upcoming events on the primary Google Calendar (time_min defaults to now).",
        parameters: {
          type: "object",
          properties: {
            time_min: { type: "string", description: "RFC3339 lower bound (optional)" },
            time_max: { type: "string", description: "RFC3339 upper bound (optional)" },
            max_results: { type: "number", description: "1-50, default 10" },
          },
        },
      },
      {
        name: "drive_search",
        class: "read",
        description: "Search Google Drive files by name substring.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Filename substring to match" },
            max_results: { type: "number", description: "1-50, default 10" },
          },
          required: ["name"],
        },
      },
      {
        name: "directory_users",
        class: "read",
        description: "List Google Workspace directory users (defaults to the admin's domain).",
        parameters: {
          type: "object",
          properties: {
            domain: { type: "string", description: "Domain to list (optional)" },
            max_results: { type: "number", description: "1-50, default 20" },
          },
        },
      },
      apiTool("Google API"),
    ],
  },
  async testConnection(config: Json, secrets) {
    await googleAccessTokenFor(config, secrets, null);
  },
  execute: googleWorkspaceExecute,
};

export default plugin;
