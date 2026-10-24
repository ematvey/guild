// The plugin dispatcher (call_plugin): resolves a connector slug to its
// execute function, re-resolves the secrets (snapshots never carry values),
// and runs the built-in connector directly or the MCP peer. One execute
// function per vendor lives under vendors/; the shared request helpers and
// the generic `api` tool live in vendors/shared.ts.

import { mcpConnect, type McpPeer } from "./mcp.js";
import { envelopeHeaders, type PluginTurn } from "./plugins.js";
import { callSignals, type Json, type ToolOutcome } from "./vendors/shared.js";
import { searxngExecute } from "./vendors/searxng.js";
import { superproxyExecute } from "./vendors/superproxy.js";
import { firecrawlExecute } from "./vendors/firecrawl.js";
import { googleWorkspaceExecute } from "./vendors/google-workspace.js";
import { hubspotExecute } from "./vendors/hubspot.js";
import { langfuseExecute } from "./vendors/langfuse.js";
import { atlassianExecute } from "./vendors/atlassian.js";
import { slackExecute } from "./vendors/slack.js";
import { githubExecute } from "./vendors/github.js";
import { gitlabExecute } from "./vendors/gitlab.js";
import {
  API_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
} from "./vendors/shared.js";

// ---------- the plugin dispatcher (call_plugin) ----------

/** Per-connector dispatch, resolved from the compiled-in catalog names. */
function builtinExecute(slug: string): ((config: Json, tool: string, args: Json, secrets: [string, string][], actingAs: string | null) => Promise<ToolOutcome>) | undefined {
  switch (slug) {
    case "searxng": return searxngExecute;
    case "superproxy": return superproxyExecute;
    case "firecrawl": return firecrawlExecute;
    case "google_workspace": return googleWorkspaceExecute;
    case "hubspot": return hubspotExecute;
    case "langfuse": return langfuseExecute;
    case "atlassian": return atlassianExecute;
    case "slack": return slackExecute;
    case "github": return githubExecute;
    case "gitlab": return gitlabExecute;
    default: return undefined;
  }
}

/** Runs one tool on a compiled-in connector directly (the script API and
 *  tests dispatch through callPlugin; this is the raw connector surface). */
export async function executeConnectorTool(
  slug: string,
  config: Json,
  tool: string,
  args: Json,
  secrets: [string, string][],
  actingAs: string | null,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  const execute = builtinExecute(slug);
  if (execute === undefined) throw new Error(`unknown integration ${slug}`);
  return callSignals.run(signal, () => execute(config, tool, args, secrets, actingAs));
}

/** Secrets the connector needs — the resolved store values ride only to
 *  execute(); the names come from the turn snapshot's declared list. */
export interface PluginCallIdentity {
  orgId: string;
  callerId: string;
  callId: string;
  actingAs: string | null;
}

/** The narrow store surface the dispatcher re-resolves secrets through
 *  (structurally the GatewayCtx slice; no store values ride the snapshot). */
export interface PluginSecretSource {
  integrationSecrets: {
    names(orgId: string, integration: string): Promise<string[]>;
    resolve(orgId: string, integration: string, names: string[], masterKey: Buffer): Promise<[string, string][]>;
  };
  masterKey(): Buffer;
}

/** Executes one call against a resolved plugin (call_plugin): re-resolves
 *  the secrets (snapshots never
 *  carry values), then runs the built-in connector directly or connects to
 *  the MCP server with the identity envelope and calls the raw tool name. */
export async function callPlugin(
  source: PluginSecretSource,
  turn: PluginTurn,
  rawTool: string,
  args: Json,
  identity: PluginCallIdentity,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  const masterKey = source.masterKey();
  if (turn.executor === "rust") {
    const execute = builtinExecute(turn.slug);
    if (execute === undefined) throw new Error(`unknown integration ${turn.slug}`);
    // Every stored secret of the slug rides to execute — the connector
    // picks what it needs (superproxy's optional gateway token included);
    // values never reach logs or events.
    const names = await source.integrationSecrets.names(identity.orgId, turn.slug);
    const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, names, masterKey);
    signal?.throwIfAborted();
    return callSignals.run(signal, () => execute(turn.rowConfig, rawTool, args, secrets, identity.actingAs));
  }
  // MCP plugin: a short-lived call connection keeps caller and call ID
  // exact (the Rust pool's per-call connect).
  const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, turn.secretNames, masterKey);
  const url = (turn.rowConfig as Json)["mcp"];
  const mcpUrl = url !== null && typeof url === "object" ? (url as Json)["url"] : undefined;
  if (typeof mcpUrl !== "string") throw new Error("mcp url missing");
  const headers = envelopeHeaders(identity.callId, identity.orgId, identity.callerId, identity.actingAs, secrets);
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

export const EXECUTE_TIMEOUTS = { CALL_TIMEOUT_MS, LIST_TIMEOUT_MS, API_TIMEOUT_MS };

