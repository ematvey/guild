// The integration dispatcher (call_plugin): resolves an integration slug to
// its execute function, re-resolves the secrets (snapshots never carry
// values), and runs the built-in integration directly or the MCP peer. The
// built-in connectors live under src/integrations/ (one directory per
// vendor; shared request helpers in integrations/shared.ts, the generic
// `api` tool in integrations/api-tool.ts).

import { relativeDestination } from "../platform/domain/paths.js";
import { mcpConnect, type McpPeer } from "./mcp.js";
import type { PluginSecretSource, IntegrationTurn } from "./plugins.js";
import { mcpRequestHeaders } from "./mcp-headers.js";
import { callSignals, type JsonObject, type ToolOutcome } from "./shared.js";
import { connectorFor, type ConnectorSource } from "./connectors.js";

// ---------- the plugin dispatcher (call_plugin) ----------

/** Runs one tool on an org's connector directly (the script API and tests
 *  dispatch through callPlugin; this is the raw connector surface). */
export async function executeConnectorTool(
  source: ConnectorSource,
  orgId: string,
  slug: string,
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  actingAs: string | null,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  const integration = await connectorFor(source, orgId, slug);
  if (integration === undefined) throw new Error(`unknown integration ${slug}`);
  return callSignals.run(signal, () => integration.execute(config, tool, args, secrets, actingAs));
}

/** Secrets the connector needs — the resolved store values ride only to
 *  execute(); the names come from the turn snapshot's declared list. */
export interface IntegrationCallIdentity {
  orgId: string;
  callerId: string;
  callId: string;
  actingAs: string | null;
  chatId?: string;
}

/** Executes one call against a resolved plugin (call_plugin): re-resolves
 *  the secrets (snapshots never
 *  carry values), then runs the built-in connector directly or connects to
 *  the MCP server with the identity envelope and calls the raw tool name. */
export async function callPlugin(
  source: PluginSecretSource & ConnectorSource,
  turn: IntegrationTurn,
  rawTool: string,
  args: JsonObject,
  identity: IntegrationCallIdentity,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  if (turn.executor === "gateway-mcp") {
    const name = turn.tools.find((tool) => tool.raw === rawTool)?.gatewayName;
    if (!name || !source.agentGateway) throw new Error("agentgateway tool unavailable");
    const { url, headers } = source.agentGateway.mcp(identity.orgId, identity.callerId, identity.actingAs, identity.chatId);
    const peer = await mcpConnect(url, headers, signal);
    const result = await peer.callTool(name, args);
    if (result.isError) throw new Error(`mcp tool error: ${result.content}`);
    const meta = result.structuredContent?.["guildMeta"];
    const outcome: ToolOutcome = { content: result.content, ...(meta === undefined ? {} : { meta }) };
    const attachment = result.structuredContent?.["guildFile"];
    if (attachment !== undefined) {
      const requested = typeof args["path"] === "string" ? relativeDestination(args["path"]) : null;
      const file = attachment as Partial<{ path: string; base64: string }> | null;
      if (turn.slug !== "google_workspace" || !["drive_get_file", "gmail_get_attachment"].includes(rawTool) ||
          !requested?.ok || file?.path !== requested.path || typeof file.base64 !== "string" ||
          file.base64.length > 48 * 1024 * 1024) {
        throw new Error("invalid MCP file result");
      }
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64) throw new Error("invalid MCP file encoding");
      outcome.file = { path: requested.path, bytes };
    }
    return outcome;
  }
  const masterKey = source.masterKey();
  if (turn.executor === "connector") {
    // Every stored secret of the slug rides to execute — the connector
    // picks what it needs (an optional credential included);
    // values never reach logs or events.
    const names = await source.integrationSecrets.names(identity.orgId, turn.slug);
    const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, names, masterKey);
    signal?.throwIfAborted();
    return executeConnectorTool(
      source,
      identity.orgId,
      turn.slug,
      turn.rowConfig,
      rawTool,
      args,
      secrets,
      identity.actingAs,
      signal,
    );
  }
  // MCP plugin: a short-lived call connection keeps caller and call ID
  // exact.
  const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, turn.secretNames, masterKey);
  const url = (turn.rowConfig as JsonObject)["mcp"];
  const mcpUrl = url !== null && typeof url === "object" ? (url as JsonObject)["url"] : undefined;
  if (typeof mcpUrl !== "string") throw new Error("mcp url missing");
  const headers = mcpRequestHeaders(
    turn.rowConfig,
    { callId: identity.callId, orgId: identity.orgId, caller: identity.callerId, actingAs: identity.actingAs },
    secrets,
  );
  let peer: McpPeer;
  try {
    peer = await mcpConnect(mcpUrl, headers, signal);
  } catch (error) {
    throw new Error(`integration ${turn.slug} unreachable: ${(error as Error).message}`);
  }
  let result;
  try {
    result = await peer.callTool(rawTool, args);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  if (result.isError) {
    throw new Error(`mcp tool error: ${result.content}`);
  }
  return { content: result.content };
}

/** A failed call's error message as the audit event keeps it: capped, so
 *  a vendor's error page does not land in the event log whole. */
export function auditError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
