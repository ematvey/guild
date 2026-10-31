// Settings wire calls: org identity, SSO, users, teams, gateway, MCP,
// integrations, registry and usage. Views render; this module owns every
// endpoint path so a settings view never names one.

import { apiUrl, getToken } from "../session";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error(
      (v as { error?: { message?: string } })?.error?.message ?? res.statusText,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** The fixed GET paths the settings sections cache. */
export const SETTINGS_PATHS = {
  org: "/api/v1/org",
  oidc: "/api/v1/admin/oidc",
  users: "/api/v1/admin/users",
  teams: "/api/v1/admin/teams",
  integrations: "/api/v1/admin/integrations",
  gatewayRoutes: "/api/v1/admin/gateway/routes",
  gatewayProviders: "/api/v1/admin/gateway/providers",
  mcpServers: "/api/v1/mcp/servers",
  registryMcp: "/api/v1/registry/mcp",
  registryIntegration: "/api/v1/registry/integration",
  usageSummary: "/api/v1/usage/summary",
} as const;

export const registryItemsPath = (kind: string) => `/api/v1/registry/${kind}`;
export const registryItemPath = (kind: string, slug: string) =>
  `/api/v1/registry/${kind}/${encodeURIComponent(slug)}`;
export const registryReviewPath = (kind: string, slug: string) =>
  `${registryItemPath(kind, slug)}/review`;
export const teamMembersPath = (teamId: string) => `/api/v1/admin/teams/${teamId}/members`;
export const integrationSecretsPath = (id: string) =>
  `/api/v1/admin/integrations/${id}/secrets`;
export const integrationToolsPath = (id: string) =>
  `/api/v1/admin/integrations/${id}/tools`;

export const usageBreakdownPath = (group: string, from: string, to: string) =>
  `/api/v1/usage?group_by=${group}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
export const usageSeriesPath = (
  group: string,
  bucket: string,
  from: string,
  to: string,
) =>
  `/api/v1/usage/series?group_by=${group}&bucket=${bucket}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
export const userUsageSeriesPath = (from: string, to: string) =>
  usageSeriesPath("user", "day", from, to);

// ---- org ----

export function getOrg<T>(): Promise<T> {
  return request<T>("GET", SETTINGS_PATHS.org);
}

export function putOrgName(name: string): Promise<void> {
  return request<void>("PUT", SETTINGS_PATHS.org, { name });
}

/** The workspace telemetry switch. Admin-only server-side; members see the
 *  value on the workspace-identity frame. */
export function putOrgTelemetry(enabled: boolean): Promise<void> {
  return request<void>("PUT", `${SETTINGS_PATHS.org}/telemetry`, { enabled });
}

export async function uploadOrgLogo(file: File): Promise<{ logo_url: string }> {
  const token = getToken();
  const res = await fetch(
    apiUrl(`${SETTINGS_PATHS.org}/logo?content_type=${encodeURIComponent(file.type)}`),
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    },
  );
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new Error((v as { error?: { message?: string } })?.error?.message ?? res.statusText);
  }
  return res.json() as Promise<{ logo_url: string }>;
}

export function deleteOrgLogo(): Promise<void> {
  return request<void>("DELETE", `${SETTINGS_PATHS.org}/logo`);
}

// ---- SSO ----

export function deleteOidc(): Promise<void> {
  return request<void>("DELETE", SETTINGS_PATHS.oidc);
}

export function putOidc(body: Record<string, string>): Promise<void> {
  return request<void>("PUT", SETTINGS_PATHS.oidc, body);
}

// ---- users ----

export function createUser<T>(body: unknown): Promise<T> {
  return request<T>("POST", SETTINGS_PATHS.users, body);
}

export function updateUser(id: string, body: unknown): Promise<void> {
  return request<void>("PUT", `${SETTINGS_PATHS.users}/${id}`, body);
}

export function deleteUser(id: string): Promise<void> {
  return request<void>("DELETE", `${SETTINGS_PATHS.users}/${id}`);
}

// ---- teams ----

export function createTeam<T>(body: unknown): Promise<T> {
  return request<T>("POST", SETTINGS_PATHS.teams, body);
}

export function updateTeam(id: string, body: unknown): Promise<void> {
  return request<void>("PUT", `${SETTINGS_PATHS.teams}/${id}`, body);
}

export function deleteTeam(id: string): Promise<void> {
  return request<void>("DELETE", `${SETTINGS_PATHS.teams}/${id}`);
}

export function addTeamMember(teamId: string, body: unknown): Promise<void> {
  return request<void>("POST", teamMembersPath(teamId), body);
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return request<void>("DELETE", `${teamMembersPath(teamId)}/${userId}`);
}

// ---- gateway: providers and routes ----

export function createProvider<T>(body: unknown): Promise<T> {
  return request<T>("POST", SETTINGS_PATHS.gatewayProviders, body);
}

export function updateProvider(slug: string, body: unknown): Promise<void> {
  return request<void>(
    "PUT",
    `${SETTINGS_PATHS.gatewayProviders}/${encodeURIComponent(slug)}`,
    body,
  );
}

export function deleteProvider(slug: string): Promise<void> {
  return request<void>(
    "DELETE",
    `${SETTINGS_PATHS.gatewayProviders}/${encodeURIComponent(slug)}`,
  );
}

export function putGatewayRoute(body: unknown): Promise<void> {
  return request<void>("PUT", SETTINGS_PATHS.gatewayRoutes, body);
}

export function deleteGatewayRoute(model: string): Promise<void> {
  return request<void>(
    "DELETE",
    `${SETTINGS_PATHS.gatewayRoutes}/${encodeURIComponent(model)}`,
  );
}

// ---- MCP servers ----

export function createMcpServer<T>(body: unknown): Promise<T> {
  return request<T>("POST", SETTINGS_PATHS.mcpServers, body);
}

export function probeMcpServer<T>(body: unknown): Promise<T> {
  return request<T>("POST", "/api/v1/mcp/probe", body);
}

export function updateMcpServer(id: string, body: unknown): Promise<void> {
  return request<void>("PATCH", `${SETTINGS_PATHS.mcpServers}/${id}`, body);
}

export function probeMcpServerById<T>(id: string): Promise<T> {
  return request<T>("POST", `${SETTINGS_PATHS.mcpServers}/${id}/probe`, {});
}

export function deleteMcpServer(id: string): Promise<void> {
  return request<void>("DELETE", `${SETTINGS_PATHS.mcpServers}/${id}`);
}

// ---- integrations ----

export function createIntegration<T>(body: unknown): Promise<T> {
  return request<T>("POST", SETTINGS_PATHS.integrations, body);
}

export function updateIntegration(id: string, body: unknown): Promise<void> {
  return request<void>("PUT", `${SETTINGS_PATHS.integrations}/${id}`, body);
}

export function deleteIntegration(id: string): Promise<void> {
  return request<void>("DELETE", `${SETTINGS_PATHS.integrations}/${id}`);
}

export function putIntegrationTool(
  id: string,
  toolName: string,
  body: unknown,
): Promise<void> {
  return request<void>(
    "PUT",
    `${integrationToolsPath(id)}/${encodeURIComponent(toolName)}`,
    body,
  );
}

// ---- registry ----

export function reviewRegistryItem(
  kind: string,
  slug: string,
  body: unknown,
): Promise<void> {
  return request<void>("POST", registryReviewPath(kind, slug), body);
}
