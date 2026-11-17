// App tools: an Agent discovers the Apps its member sees, reads one with its
// page, changes its Access list, and runs a data function as the member
// (docs/domain/004-capabilities.md, "Apps"). `publish_app` creates the
// versions; these tools reach the ones that already exist.

import { mkdir } from "node:fs/promises";
import { Type } from "typebox";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_APP_HTML_BYTES, type AppRow, type AppStore } from "../platform/store/apps.js";
import type { AccessInput, AccessStore } from "../platform/store/access.js";
import {
  AppFunctionError,
  appFunctionClass,
  bindAppFunction,
  type AppFunction,
  type JsonObject,
} from "../platform/domain/app-functions.js";
import { ApiError } from "../platform/errors.js";
import { isUuid } from "../platform/time.js";
import {
  memberTool,
  runMemberTool,
  type IntegrationCaller,
  type MemberToolResult,
} from "../integrations/member-tools.js";
import type { IntegrationGateway } from "../integrations/plugins.js";
import type { IntegrationAccessStore } from "../platform/store/integration-access.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { EventStore } from "../platform/store/events.js";
import type { IdentityStore } from "../platform/store/identity.js";
import type { AppCallGate } from "../harness/approvals.js";
import type { Agent } from "./types.js";
import { agentWorkspaceDir } from "./workspace-config.js";
import { writeWorkspaceFile, WorkspaceFsError } from "./workspace-fs.js";
import { structured } from "../harness/tool-schema.js";

/** The member's reach on one data function's tool: its class and the Org's
 *  curation, or why they cannot call it. */
export interface AppFunctionGate {
  ok: boolean;
  class: string | null;
  alwaysAsk: boolean;
  reason: string | null;
}

/** The App store, the Access store, and the two calls that act for the
 *  member: the reach check and the function run. */
export interface AppToolsContext {
  apps: Pick<AppStore, "listVisible" | "getVisible" | "page">;
  access: Pick<AccessStore, "entries" | "replace">;
  agent: Agent;
  chatId: string;
  /** The member the thread acts for: every read, edit and call acts as them. */
  userId: string;
  userRole: string;
  userEmail: string | null;
  /** The agent workspace volume as this process sees it. */
  workspaceRoot: string;
  /** Why the member cannot call one function's tool; null when they can. */
  functionGate(orgId: string, userId: string, fn: AppFunction): Promise<AppFunctionGate>;
  /** Runs one function for the member: their reach, the Org's curation and
   *  the `integration.tool_called` audit, as the page's call route does. */
  callFunction(input: {
    orgId: string;
    userId: string;
    email: string | null;
    role: string;
    appId: string;
    fn: AppFunction;
    args: JsonObject;
  }): Promise<MemberToolResult>;
}

/** The largest function result an Agent reads in one call; a longer result
 *  is cut with a note that names the cap. */
export const MAX_CALL_APP_RESULT_CHARS = 64 * 1024;

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/** One App as the list carries it: what it is, and whether the member may
 *  edit it. */
function appLine(row: AppRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner: row.owner_label,
    version: row.version,
    visibility: row.visibility,
    can_edit: row.can_edit,
    functions: row.functions.map((fn) => ({ name: fn.name, description: fn.description })),
  };
}

const viewer = (context: AppToolsContext) => ({ id: context.userId, role: context.userRole });

type AppLookup = { row: AppRow; error?: undefined } | { row?: undefined; error: ToolExecutionResult };

/** One App of the org, or a tool error naming the reason. */
async function visibleApp(context: AppToolsContext, appId: string): Promise<AppLookup> {
  if (!isUuid(appId)) return { error: textErr("app_id must be an App's id") };
  try {
    return { row: await context.apps.getVisible(context.agent.org_id, appId, viewer(context)) };
  } catch (error) {
    if (error instanceof ApiError) return { error: textErr(error.message) };
    throw error;
  }
}

export const LIST_APPS_DESCRIPTION = `List the Guild Apps this member can open: pages that read live Integration data through named data functions. Each row carries the id, name, description, owner, version, whether the member may edit it, and its function names. Use read_app for one App's functions and page, publish_app to create or update one, set_app_access to share one, and call_app to run a function.`;

export function createListAppsTool(context: AppToolsContext): ToolRegistration {
  return defineTool({
    name: "list_apps",
    description: LIST_APPS_DESCRIPTION,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keep only Apps whose name or description contains this text" })),
    }),
    structuredOutputSchema: Type.Object({ apps: Type.Array(Type.Any()) }),
    replay: "safe",
    callers: ["tools"],
    outputLimits: { maxBytes: 32 * 1024 },
    execute: async (args) => {
      const rows = (await context.apps.listVisible(context.agent.org_id, [context.userId])).get(context.userId) ?? [];
      const query = (args.query ?? "").trim().toLowerCase();
      const kept =
        query === ""
          ? rows
          : rows.filter(
              (row) =>
                row.name.toLowerCase().includes(query) ||
                row.description.toLowerCase().includes(query) ||
                row.functions.some((fn) => fn.name.toLowerCase().includes(query)),
            );
      return { structuredOutput: structured({ apps: kept.map(appLine) }) };
    },
  });
}

export const READ_APP_DESCRIPTION = `Read one Guild App: its manifest (name, description, owner, version, who may open and edit it) and every data function with its arguments, parameters and whether this member can call it. With page: true (the default) the App's page HTML is written to the workspace and its path returned, so you can edit that file and publish it back with publish_app.`;

export function createReadAppTool(context: AppToolsContext): ToolRegistration {
  return defineTool({
    name: "read_app",
    description: READ_APP_DESCRIPTION,
    parameters: Type.Object({
      app_id: Type.String({ description: "The App's id" }),
      page: Type.Optional(Type.Boolean({ description: "Write the page HTML into the workspace (default true)" })),
    }),
    structuredOutputSchema: Type.Object({
      app: Type.Any(),
      access: Type.Array(Type.Any()),
      functions: Type.Array(Type.Any()),
      page: Type.Any(),
    }),
    replay: "safe",
    callers: ["tools"],
    outputLimits: { maxBytes: 64 * 1024 },
    execute: async (args) => {
      const found = await visibleApp(context, args.app_id);
      if (found.row === undefined) return found.error;
      const row = found.row;
      const orgId = context.agent.org_id;
      const [access, functions] = await Promise.all([
        context.access.entries(orgId, "app", row.id),
        Promise.all(
          row.functions.map(async (fn) => ({
            name: fn.name,
            description: fn.description,
            integration: fn.integration,
            tool: fn.tool,
            args: fn.args,
            params: fn.params,
            gate: await context.functionGate(orgId, context.userId, fn),
          })),
        ),
      ]);
      let page: Record<string, unknown> | null = null;
      if (args.page !== false) {
        const stored = await context.apps.page(row.id, row.version);
        const rel = `apps/${row.id}/index.html`;
        const root = agentWorkspaceDir(context.workspaceRoot, orgId, context.agent.id);
        try {
          await mkdir(root, { recursive: true });
          await writeWorkspaceFile(root, rel, stored.html, {});
        } catch (error) {
          if (!(error instanceof WorkspaceFsError)) throw error;
          return textErr(`the page could not be written to the workspace: ${error.message}`);
        }
        page = {
          path: rel,
          bytes: Buffer.byteLength(stored.html),
          max_bytes: MAX_APP_HTML_BYTES,
          sha256: stored.sha256,
        };
      }
      return {
        structuredOutput: structured({
          app: appLine(row),
          access,
          functions,
          page,
        }),
      };
    },
  });
}

export const SET_APP_ACCESS_DESCRIPTION = `Replace who may open and edit a Guild App. Each entry names a subject (the whole org, a team, or a member) and a level: read opens the App, edit also lets them publish new versions and change this list. The owner, an admin, or an editor of the App may set it. This does not publish a version: the page and its functions stay as they are.`;

const entrySchema = Type.Object({
  subject_kind: Type.Union([Type.Literal("org"), Type.Literal("team"), Type.Literal("user")], {
    description: "The whole org, one team, or one member",
  }),
  subject_id: Type.Optional(Type.String({ description: "The team's or member's id; omit for org" })),
  level: Type.Union([Type.Literal("read"), Type.Literal("edit")], {
    description: "read opens the App; edit also publishes and shares it",
  }),
});

export function createSetAppAccessTool(context: AppToolsContext): ToolRegistration {
  return defineTool({
    name: "set_app_access",
    description: SET_APP_ACCESS_DESCRIPTION,
    parameters: Type.Object({
      app_id: Type.String({ description: "The App's id" }),
      entries: Type.Array(entrySchema, { description: "The complete list; it replaces the current one" }),
    }),
    structuredOutputSchema: Type.Object({ entries: Type.Array(Type.Any()) }),
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: 16 * 1024 },
    execute: async (args) => {
      const found = await visibleApp(context, args.app_id);
      if (found.row === undefined) return found.error;
      const row = found.row;
      if (!row.can_edit) return textErr("you cannot edit this App");
      const entries: AccessInput[] = [];
      for (const entry of args.entries) {
        const id = entry.subject_id ?? null;
        if (entry.subject_kind === "org") {
          if (id !== null) return textErr("an org entry takes no subject_id");
          entries.push({ subject_kind: "org", subject_id: null, level: entry.level });
          continue;
        }
        if (id === null || !isUuid(id)) {
          return textErr(`a ${entry.subject_kind} entry needs that ${entry.subject_kind}'s id`);
        }
        entries.push({ subject_kind: entry.subject_kind, subject_id: id, level: entry.level });
      }
      try {
        await context.access.replace(context.agent.org_id, "app", row.id, entries);
      } catch (error) {
        if (error instanceof ApiError) return textErr(error.message);
        throw error;
      }
      const stored = await context.access.entries(context.agent.org_id, "app", row.id);
      return { structuredOutput: structured({ entries: stored }) };
    },
  });
}

export const CALL_APP_DESCRIPTION = `Run one data function of a Guild App as this member. The function fixes its tool and arguments; pass only the parameters it declares, with values inside their bounds. A read-class function runs at once. A function whose tool can change data asks the member first, every call, and runs only after they say yes. The call acts for the member: their Integration access, the org's curation, and the audit event.`;

export function createCallAppTool(context: AppToolsContext): ToolRegistration {
  return defineTool({
    name: "call_app",
    description: CALL_APP_DESCRIPTION,
    parameters: Type.Object({
      app_id: Type.String({ description: "The App's id" }),
      function: Type.String({ description: "The data function's name, as read_app lists it" }),
      params: Type.Optional(Type.Any({ description: "The declared parameters, as an object" })),
    }),
    structuredOutputSchema: Type.Object({ ok: Type.Boolean(), content: Type.String(), meta: Type.Any() }),
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: MAX_CALL_APP_RESULT_CHARS },
    execute: async (args) => {
      const found = await visibleApp(context, args.app_id);
      if (found.row === undefined) return found.error;
      const row = found.row;
      const fn = row.functions.find((item) => item.name === args.function);
      if (fn === undefined) {
        const names = row.functions.map((item) => item.name).join(", ") || "none";
        return textErr(`this App has no function "${args.function}" (functions: ${names})`);
      }
      const gate = await context.functionGate(context.agent.org_id, context.userId, fn);
      if (!gate.ok) return textErr(`${fn.name} cannot run for you: ${gate.reason ?? "unavailable"}`);
      let bound: JsonObject;
      try {
        bound = bindAppFunction(fn, args.params);
      } catch (error) {
        if (error instanceof AppFunctionError) return textErr(error.message);
        throw error;
      }
      const result = await context.callFunction({
        orgId: context.agent.org_id,
        userId: context.userId,
        email: context.userEmail,
        role: context.userRole,
        appId: row.id,
        fn,
        args: bound,
      });
      if (!result.ok) return { structuredOutput: structured({ ok: false, content: result.error, meta: null }) };
      const cut =
        result.content.length > MAX_CALL_APP_RESULT_CHARS
          ? `${result.content.slice(0, MAX_CALL_APP_RESULT_CHARS)}\n\n(the result is longer and was cut; narrow the query)`
          : result.content;
      return { structuredOutput: structured({ ok: true, content: cut, meta: result.meta }) };
    },
  });
}

/** The four App tools over one context. */
export function createAppTools(context: AppToolsContext): ToolRegistration[] {
  return [
    createListAppsTool(context),
    createReadAppTool(context),
    createCallAppTool(context),
    createSetAppAccessTool(context),
  ];
}

/** The prompt's `apps` section: the Apps this member can open, one line each,
 *  with the tools that act on them. Read per turn, so a publish or a change
 *  of access reaches the next turn. */
export const MAX_APPS_INDEX_LINES = 40;

export function renderAppsIndex(rows: readonly AppRow[]): string | null {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, MAX_APPS_INDEX_LINES);
  const lines = shown.map((row) => {
    const functions = row.functions.map((fn) => fn.name).join(", ");
    return `- ${row.name} (id ${row.id}, v${row.version}, by ${row.owner_label}${row.can_edit ? ", editable by you" : ""})${functions === "" ? "" : `: ${functions}`}${row.description === "" ? "" : ` — ${row.description}`}`;
  });
  return [
    "Apps this member can open, with their data functions. read_app reads one with its page; call_app runs a function; publish_app publishes a version of one you may edit; set_app_access shares one.",
    ...lines,
    ...(rows.length > shown.length ? [`- and ${rows.length - shown.length} more; list_apps shows all`] : []),
  ].join("\n");
}

/** The member's reach on one data function's tool, through the same rules a
 *  call runs: the Integration's audience, the Org's curation and the class —
 *  the function's own declaration where the tool's class cannot say it. */
export function appFunctionGate(
  gateway: IntegrationGateway,
  access: IntegrationAccessStore,
  identity: Pick<IdentityStore, "getUser">,
): AppToolsContext["functionGate"] {
  return async (orgId, userId, fn) => {
    const user = await identity.getUser(userId);
    try {
      const tool = await memberTool(
        gateway,
        access,
        { org: orgId, userId, email: user.email, role: user.role },
        fn.integration,
        fn.tool,
      );
      return { ok: true, class: appFunctionClass(fn, tool), alwaysAsk: tool.alwaysAsk, reason: null };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, class: null, alwaysAsk: false, reason: error.message };
      throw error;
    }
  };
}

/** Runs one data function for the member and records the audit event, as the
 *  page's call route does (`via: "app"`). */
export function appFunctionCall(
  gateway: IntegrationGateway,
  access: IntegrationAccessStore,
  events: Pick<EventStore, "emit">,
): AppToolsContext["callFunction"] {
  return async ({ orgId, userId, email, role, appId, fn, args }) => {
    const caller: IntegrationCaller = { org: orgId, userId, email, role };
    const tool = await memberTool(gateway, access, caller, fn.integration, fn.tool);
    return runMemberTool(gateway, events, caller, tool.turn, tool.raw, args, email, {
      via: "app",
      app_id: appId,
      function: fn.name,
    });
  };
}

/** The approval gate's classifier for `call_app`: a function curated to always
 *  ask needs the member's yes, whatever the Thread's mode. A read-class
 *  function flows, a write- or admin-class function goes to the Thread's
 *  approval mode ("policy"), and a function the member cannot call flows too:
 *  the tool answers the refusal itself. */
export function createAppCallGate(deps: {
  apps: Pick<AppStore, "getVisible">;
  chats: Pick<ChatStore, "ownerOf">;
  chatOfConversation(conversationId: number): Promise<string | null>;
  functionGate: AppToolsContext["functionGate"];
}): AppCallGate {
  return {
    async decision(conversationId, call) {
      if (call.name !== "call_app") return undefined;
      const appId = call.arguments?.["app_id"];
      const name = call.arguments?.["function"];
      if (typeof appId !== "string" || typeof name !== "string") return undefined;
      const chatId = await deps.chatOfConversation(conversationId);
      if (chatId === null) return undefined;
      const owner = await deps.chats.ownerOf(chatId);
      if (owner === null) return undefined;
      const row = await deps.apps
        .getVisible(owner.org_id, appId, { id: owner.user_id, role: owner.role })
        .catch(() => null);
      if (row === null) return undefined;
      const fn = row.functions.find((item) => item.name === name);
      if (fn === undefined) return undefined;
      const gate = await deps.functionGate(owner.org_id, owner.user_id, fn);
      if (!gate.ok) return undefined;
      if (gate.alwaysAsk) return "ask";
      return gate.class !== "read" ? "policy" : undefined;
    },
  };
}
