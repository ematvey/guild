// publish_app: publishes one HTML file from the agent's workspace as an App
// (docs/domain/004-capabilities.md, "Apps"), or a new version of an App the
// thread's member owns. The App's data functions are checked against that
// member's Integration reach before anything is stored, so a wrong tool name
// or an out-of-reach Integration comes back to the agent as an error it can
// fix.

import { Type } from "typebox";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AppStore } from "../platform/store/apps.js";
import { MAX_APP_DESCRIPTION, MAX_APP_HTML_BYTES, MAX_APP_NAME } from "../platform/store/apps.js";
import { AppFunctionError, parseAppFunctions, type AppFunction } from "../platform/domain/app-functions.js";
import { ApiError } from "../platform/errors.js";
import { isUuid } from "../platform/time.js";
import type { Agent } from "./types.js";
import { normalizeRelativePath } from "./files.js";
import { agentWorkspaceDir } from "./workspace-config.js";
import { readWorkspaceFile, WorkspaceFsError } from "./workspace-fs.js";
import { structured } from "../harness/tool-schema.js";
import { memberTool } from "../integrations/member-tools.js";
import type { IntegrationGateway } from "../integrations/plugins.js";
import type { IntegrationAccessStore } from "../platform/store/integration-access.js";
import type { IdentityStore } from "../platform/store/identity.js";

export interface PublishAppContext {
  apps: Pick<AppStore, "publish">;
  agent: Agent;
  chatId: string;
  /** The member the thread acts for: the App's owner. */
  userId: string;
  /** The agent workspace volume as this process sees it. */
  workspaceRoot: string;
  /** Why the member cannot call one function's tool; null when they can. */
  checkFunction(orgId: string, userId: string, fn: AppFunction): Promise<string | null>;
}

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

const output = Type.Object({
  app_id: Type.String(),
  version: Type.Number(),
  url: Type.String(),
  name: Type.String(),
  functions: Type.Array(Type.String()),
});

export const PUBLISH_APP_DESCRIPTION = `Publish an HTML file from your workspace as a Guild App: a page the member opens from Apps (and can share with the org) that reads live data from the org's Integrations. Pass app_id to publish a new version of an App you published before.

The page runs sandboxed with no network: fetch, XHR, WebSocket, remote images and popups are blocked. Scripts, styles and fonts may load from cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com and Google Fonts; inline <script> and <style> work. Data comes only through data functions, declared here and called from the page:

  await guild.ready;                                   // the App's facts and theme
  const rows = await guild.call("deals_by_stage", { stage: "won" });   // parsed JSON, or text
  window.addEventListener("guild:theme", e => ...);    // "light" | "dark"; also <html data-theme>

A data function is one Integration tool with fixed arguments. Write {"$param": "<name>"} where the page supplies a value, and declare each parameter's type (string, number, integer, boolean) with optional enum, default, required, max_length, minimum, maximum. Example:
  {"name": "deals_by_stage", "description": "Deals in one stage", "integration": "hubspot", "tool": "hubspot_search_deals",
   "args": {"filters": [{"property": "dealstage", "value": {"$param": "stage"}}], "limit": 100},
   "params": {"stage": {"type": "string", "enum": ["won", "lost", "open"], "default": "open"}}}
Find tool names and argument schemas with <slug>_list_tools, and call the tool once yourself to learn the result's shape. Each viewer's own Integration access applies when they open the App; a write-class tool (the raw <slug>_api tools included, even for a search) asks each viewer to approve its function before it runs, once per App version if they choose. Prefer read-class tools; use a raw api tool only when no read tool can express the query, and name the function so the viewer can tell it only reads. Design for both light and dark themes and for narrow widths, handle errors from guild.call, and show loading states.`;

export function createPublishAppTool(context: PublishAppContext): ToolRegistration {
  return defineTool({
    name: "publish_app",
    description: PUBLISH_APP_DESCRIPTION,
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path of the App's HTML file (one self-contained page)" }),
      name: Type.String({ description: `The App's name, at most ${MAX_APP_NAME} characters` }),
      description: Type.Optional(
        Type.String({ description: `What the App shows, at most ${MAX_APP_DESCRIPTION} characters` }),
      ),
      app_id: Type.Optional(Type.String({ description: "Publish a new version of this App instead of a new App" })),
      functions: Type.Optional(
        Type.Array(Type.Any(), { description: "The App's data functions (see the tool description)" }),
      ),
    }),
    structuredOutputSchema: output,
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: 8 * 1024 },
    execute: async (args) => {
      const name = args.name.trim();
      if (name === "" || name.length > MAX_APP_NAME) return textErr(`name must be 1–${MAX_APP_NAME} characters`);
      const description = (args.description ?? "").trim();
      if (description.length > MAX_APP_DESCRIPTION) {
        return textErr(`description must be at most ${MAX_APP_DESCRIPTION} characters`);
      }
      if (args.app_id !== undefined && !isUuid(args.app_id)) return textErr("app_id must be an App's id");
      let functions: AppFunction[];
      try {
        functions = parseAppFunctions(args.functions);
      } catch (error) {
        if (error instanceof AppFunctionError) return textErr(`functions: ${error.message}`);
        throw error;
      }
      const problems: string[] = [];
      for (const fn of functions) {
        const problem = await context.checkFunction(context.agent.org_id, context.userId, fn);
        if (problem !== null) problems.push(`${fn.name} (${fn.integration}/${fn.tool}): ${problem}`);
      }
      if (problems.length > 0) {
        return textErr(`these functions cannot run for the member:\n${problems.join("\n")}`);
      }
      const rel = normalizeRelativePath(args.path);
      if (rel === "") return textErr("path must name a file");
      const root = agentWorkspaceDir(context.workspaceRoot, context.agent.org_id, context.agent.id);
      let html: string;
      try {
        const { bytes } = await readWorkspaceFile(root, rel, { maxBytes: MAX_APP_HTML_BYTES, overflow: "refuse" });
        html = bytes.toString("utf8");
      } catch (error) {
        if (!(error instanceof WorkspaceFsError)) throw error;
        if (error.reason === "too_large") return textErr("the page is larger than 2 MiB");
        return textErr(error.message);
      }
      try {
        const app = await context.apps.publish({
          orgId: context.agent.org_id,
          ownerUserId: context.userId,
          agentId: context.agent.id,
          chatId: context.chatId,
          ...(args.app_id === undefined ? {} : { appId: args.app_id }),
          name,
          description,
          html,
          functions,
        });
        return {
          structuredOutput: structured({
            app_id: app.id,
            version: app.version,
            url: `/apps/${app.id}`,
            name: app.name,
            functions: app.functions.map((fn) => fn.name),
          }),
        };
      } catch (error) {
        if (error instanceof ApiError) return textErr(error.message);
        throw error;
      }
    },
  });
}

/** The publish-time reach check: whether the member could call each
 *  function's tool right now, through the same rules a call runs. */
export function appFunctionCheck(
  gateway: IntegrationGateway,
  access: IntegrationAccessStore,
  identity: Pick<IdentityStore, "getUser">,
): PublishAppContext["checkFunction"] {
  return async (orgId, userId, fn) => {
    const user = await identity.getUser(userId);
    try {
      await memberTool(
        gateway,
        access,
        { org: orgId, userId, email: user.email, role: user.role },
        fn.integration,
        fn.tool,
      );
      return null;
    } catch (error) {
      if (error instanceof ApiError) return error.message;
      throw error;
    }
  };
}
