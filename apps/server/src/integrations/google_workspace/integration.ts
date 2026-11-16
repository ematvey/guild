import { googleAdminAccessToken, GOOGLE_GRANTED_SCOPES } from "./execute.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { googleWorkspaceExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

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
        obtain:
          "Leave the default. Change it only when Google API traffic must go through a proxy; then " +
          "enter the proxy's base URL.",
      },
      {
        name: "token_url",
        kind: "string",
        label: "Token URL",
        required: false,
        default: "https://oauth2.googleapis.com/token",
        help: "Override only for a Google API proxy",
        placeholder: null,
        obtain:
          "Leave the default. Change it only when Google's OAuth token endpoint must be reached " + "through a proxy.",
      },
      {
        name: "admin_email",
        kind: "string",
        label: "Admin email",
        required: true,
        default: null,
        help: "Workspace admin the connection test acts as",
        placeholder: "admin@yourorg.com",
        obtain:
          "A Workspace admin who can read the user directory (a super admin works). Guild acts as " +
          "this user only for **Test connection**; a call without a member identity is refused. " +
          "`directory_users` lists this user's domain by default.",
      },
      {
        name: "service_account_json",
        kind: "secret",
        label: "Service account JSON",
        required: true,
        default: null,
        help: null,
        placeholder: "{ … }",
        obtain:
          "1. In [Google Cloud → IAM & Admin → Service " +
          "accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service " +
          "account, then **Keys → Add key → Create new key → JSON**. Paste the whole file here.\n2. " +
          "In the same project, enable the Gmail, Google Calendar, Google Drive and Admin SDK " +
          "APIs.\n3. In [Admin console → Security → API controls → Domain-wide " +
          "delegation](https://admin.google.com/ac/owl/domainwidedelegation), add the service " +
          "account's client ID with these scopes:\n   " +
          "`https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly`",
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
          "Fetch one Gmail attachment into the working folder. Get the attachment id from gmail_get_message's attachment list.",
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "string" },
            attachment_id: { type: "string" },
            path: {
              type: "string",
              description: "Destination path relative to the working folder.",
            },
          },
          required: ["message_id", "attachment_id", "path"],
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
        name: "drive_get_file",
        class: "read",
        description:
          "Download one Drive file into the working folder. An uploaded file (xlsx, pdf, image, docx…) comes back byte for byte. A native Google Doc, Sheet, Slide or Drawing is exported: markdown, csv, pdf and png by default, or the format given in mime_type. Get the id from drive_search.",
        parameters: {
          type: "object",
          properties: {
            file_id: { type: "string", description: "Drive file id" },
            path: {
              type: "string",
              description: "Destination path relative to the working folder.",
            },
            mime_type: {
              type: "string",
              description:
                "Export format for a native Google file (optional): text/markdown, text/plain, text/csv, text/tab-separated-values, text/html, application/pdf, application/rtf, application/zip, application/epub+zip, image/png, image/jpeg, image/svg+xml, the Office and OpenDocument formats. Ignored for uploaded files, which have one format.",
            },
          },
          required: ["file_id", "path"],
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
      apiTool("Google API", { scopes: GOOGLE_GRANTED_SCOPES, class: "read" }),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    await googleAdminAccessToken(config, secrets);
  },
  execute: googleWorkspaceExecute,
};

export default plugin;
