// Org MCP integrations added from the admin UI. An admin names a remote
// MCP server (URL plus credential headers), Guild probes it, writes the
// registry manifest for it (published by the admin and approved in the same
// step: the admin is the reviewer), and stores the enabled integration row
// with the chosen tools and their classes. From then on it is an ordinary
// registry MCP integration: the shop lists it, the settings page edits it,
// the turn resolver serves it.

import { randomUUID } from "node:crypto";
import { ApiError } from "../platform/errors.js";
import { isToolClass, type ToolClass } from "../platform/domain/tool-class.js";
import { packBundle } from "../platform/bundle.js";
import { BundleWriteError, bundleSha256, publishRegistryBundle, type Publisher } from "../platform/registry-publish.js";
import { singleLineDescription, validateV2, type Manifest } from "../platform/registry-manifest.js";
import { nextVersion, type RegistryStore } from "../platform/store/registry.js";
import type { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import type { TeamStore } from "../platform/store/teams.js";
import type { EventStore } from "../platform/store/events.js";
import type { ObjectStore } from "../platform/s3.js";
import { integrationByName } from "./loader.js";
import { mcpConnect, type McpTool } from "./mcp.js";
import { headerSecretName, mcpRequestHeaders, validateHeaderTemplates } from "./mcp-headers.js";

export interface OrgMcpDeps {
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  readonly registry: RegistryStore;
  readonly teams: Pick<TeamStore, "isMember">;
  readonly events: Pick<EventStore, "emit">;
  readonly objects: Pick<ObjectStore, "put">;
  masterKey(): Buffer;
}

/** The connection half of the form: where the server is and what it needs. */
export interface OrgMcpConnection {
  url: string;
  /** Header name → its stored value template, e.g. `{authorization}`. */
  templates: Record<string, string>;
  /** Secret name → value, the credential each template references. */
  secrets: [string, string][];
  envelope: boolean;
}

/** One discovered tool as the create form shows it. */
export interface ProbedTool {
  name: string;
  description: string;
  /** The class Guild suggests from the server's hints and the tool name. */
  class: ToolClass;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TOOL_NAME = /^[a-zA-Z0-9_.-]+$/;
const READ_VERB =
  /^(get|list|search|read|fetch|find|query|describe|lookup|show|view|count|check|retrieve|browse)([_.-]|[A-Z]|$)/i;

/** The class a tool starts with: the server's own hints first (read-only →
 *  read, destructive → write), then a read verb at the start of its name;
 *  anything else is write, so a member's default read-only policy never
 *  reaches a tool nobody looked at. */
export function suggestedToolClass(tool: McpTool): ToolClass {
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "write";
  return READ_VERB.test(tool.name) ? "read" : "write";
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the connection fields of a probe or create body. Every header
 *  needs a name and a value; each value becomes one secret. */
export function parseConnection(body: Record<string, unknown>): OrgMcpConnection {
  const url = str(body, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ApiError.badRequest("url must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw ApiError.badRequest("url must be an absolute http(s) URL");
  }
  const rawHeaders = Array.isArray(body["headers"]) ? (body["headers"] as unknown[]) : [];
  const templates: Record<string, string> = {};
  const secrets: [string, string][] = [];
  for (const raw of rawHeaders) {
    const h = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = typeof h["name"] === "string" ? h["name"].trim() : "";
    const value = typeof h["value"] === "string" ? h["value"] : "";
    if (name === "" && value === "") continue;
    if (name === "") throw ApiError.badRequest("every header needs a name");
    if (value === "") throw ApiError.badRequest(`header ${name} needs a value`);
    const secretName = headerSecretName(name);
    if (secretName === "") throw ApiError.badRequest(`header ${name} is not a valid header name`);
    if (secrets.some(([n]) => n === secretName)) throw ApiError.badRequest(`header ${name} is listed twice`);
    templates[name] = `{${secretName}}`;
    secrets.push([secretName, value]);
  }
  try {
    validateHeaderTemplates(templates);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  return { url, templates, secrets, envelope: body["envelope"] !== false };
}

/** Connects with the would-be headers and lists the server's tools. */
async function listServerTools(orgId: string, connection: OrgMcpConnection): Promise<McpTool[]> {
  const rowConfig = { mcp: { url: connection.url, headers: connection.templates, envelope: connection.envelope } };
  const headers = mcpRequestHeaders(
    rowConfig,
    { callId: randomUUID(), orgId, caller: null, actingAs: null },
    connection.secrets,
  );
  let peer;
  try {
    peer = await mcpConnect(connection.url, headers, AbortSignal.timeout(30_000));
  } catch (error) {
    throw ApiError.badRequest(`MCP server unreachable: ${(error as Error).message}`);
  }
  try {
    return await peer.listTools();
  } catch (error) {
    throw ApiError.badRequest(`MCP tools/list failed: ${(error as Error).message}`);
  }
}

/** The probe: connects and returns the tools with their suggested class. */
export async function probeOrgMcp(orgId: string, body: Record<string, unknown>): Promise<ProbedTool[]> {
  const tools = await listServerTools(orgId, parseConnection(body));
  return tools
    .filter((t) => TOOL_NAME.test(t.name))
    .map((t) => ({ name: t.name, description: t.description, class: suggestedToolClass(t) }));
}

/** The tool selection of a create body, keyed by tool name. Absent: every
 *  discovered tool, enabled, at its suggested class. */
function parseSelection(
  body: Record<string, unknown>,
  discovered: McpTool[],
): Map<string, { enabled: boolean; cls: ToolClass }> {
  const out = new Map<string, { enabled: boolean; cls: ToolClass }>();
  for (const t of discovered) {
    if (TOOL_NAME.test(t.name)) out.set(t.name, { enabled: true, cls: suggestedToolClass(t) });
  }
  if (!Array.isArray(body["tools"])) return out;
  for (const raw of body["tools"] as unknown[]) {
    const t = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = typeof t["name"] === "string" ? t["name"] : "";
    const current = out.get(name);
    if (current === undefined) continue; // not served — nothing to curate
    out.set(name, {
      enabled: typeof t["enabled"] === "boolean" ? t["enabled"] : current.enabled,
      cls: isToolClass(t["class"]) ? t["class"] : current.cls,
    });
  }
  return out;
}

/** Creates one org MCP integration: probe, publish + approve its manifest,
 *  and store the enabled row with its credentials and tool curation.
 *  Returns the slug. */
export async function createOrgMcp(
  deps: OrgMcpDeps,
  publisher: Publisher,
  body: Record<string, unknown>,
): Promise<string> {
  const orgId = publisher.orgId;
  const slug = str(body, "slug");
  if (!SLUG.test(slug)) {
    throw ApiError.badRequest("slug must start with a letter or digit and use only a-z, 0-9, _ and -, up to 48 chars");
  }
  if (integrationByName(slug) !== undefined) {
    throw ApiError.conflict("slug_taken", `${slug} is the name of a built-in integration`);
  }
  if ((await deps.integrations.getByName(orgId, slug)) !== null) {
    throw ApiError.conflict("already_configured", `integration ${slug} already has a configuration`);
  }
  const title = str(body, "title") || slug;
  const description = str(body, "description");
  const summary = singleLineDescription(str(body, "summary") || description || `${title} MCP server`);
  const connection = parseConnection(body);
  const discovered = await listServerTools(orgId, connection);
  const selection = parseSelection(body, discovered);

  const secretNames = connection.secrets.map(([n]) => n);
  const headerOf = new Map(Object.entries(connection.templates).map(([h, t]) => [t.slice(1, -1), h]));
  const version = nextVersion(await deps.registry.itemVersions(orgId, "integration", slug));
  const manifest = {
    kind: "integration",
    slug,
    version,
    title,
    summary,
    description,
    publisher: publisher.label,
    mcp: { url: connection.url, headers: connection.templates, envelope: connection.envelope },
    auth: { kind: "org_secret", secret_names: secretNames, identity_key: "email" },
    settings: {
      fields: secretNames.map((name) => ({
        name,
        kind: "secret",
        label: `${headerOf.get(name) ?? name} header`,
        required: true,
        default: null,
        help: "The full header value the server expects, e.g. Bearer <token>",
        placeholder: null,
      })),
    },
    tools: { classes: Object.fromEntries([...selection].map(([name, s]) => [name, s.cls])) },
  };
  try {
    validateV2(manifest as unknown as Manifest);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  const bytes = packBundle({ "manifest.json": JSON.stringify(manifest, null, 2) });
  try {
    await publishRegistryBundle(
      { registry: deps.registry, teams: deps.teams, events: deps.events, objects: deps.objects },
      publisher,
      { kind: "integration", slug, version, description: summary, manifest },
      bytes,
    );
  } catch (error) {
    if (error instanceof BundleWriteError) throw ApiError.internal(error.message);
    throw error;
  }
  await deps.registry.setReview(orgId, "integration", slug, "approved", version, bundleSha256(bytes));

  const config = {
    mcp: manifest.mcp,
    auth: manifest.auth,
    tool_policy: {},
    tools: Object.fromEntries(
      [...selection].map(([name, s]) => [name, { enabled: s.enabled, approval: "default", class: s.cls }]),
    ),
  };
  await deps.integrations.saveWithSecrets(
    deps.integrationSecrets,
    orgId,
    slug,
    config,
    true,
    connection.secrets,
    deps.masterKey(),
  );
  try {
    await deps.events.emit(orgId, "integration.mcp_added", {
      integration: slug,
      url: connection.url,
      by: publisher.userId,
    });
  } catch {
    // best-effort audit
  }
  return slug;
}
