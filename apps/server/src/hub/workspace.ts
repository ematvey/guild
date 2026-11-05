// Workspace snapshots: the sidebar's whole live state — active chats,
// archived chats, projects, the machine registry, the model list and the
// member's own profile. The feed pushes them
// together on every workspace change, so no client reads them over HTTP.

import type { Config } from "../config.js";
import type { IdentityStore, UserRow } from "../platform/store/identity.js";
import type { MachineRow, MachineStore } from "../platform/store/machines.js";
import type { ProjectRow, ProjectStore } from "../platform/store/projects.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { OrgStore } from "../platform/store/orgs.js";
import type { OrgKvStore, RemoteImagesPolicy } from "../platform/store/org-kv.js";
import type { GatewayStore } from "../platform/store/gateway.js";
import type { Chat, MachineInfo, UserInfo } from "@guild/wire/rest";
import { userInfo } from "../platform/domain/user-info.js";
import type { ModelOption } from "@guild/wire/types";
import { servedWebBundle } from "../platform/web-bundle.js";
import { chatWire, type ChatWireHub } from "../chats/chat-wire.js";
import { DEFAULT_CONTEXT_WINDOW } from "../chats/context-usage.js";

type Caller = Pick<UserRow, "org_id" | "id">;

/** The stores and hub reads the workspace snapshots take. */
export interface WorkspaceReads {
  readonly config: Pick<Config, "webDistDir">;
  readonly hub: ChatWireHub;
  readonly chats: Pick<ChatStore, "listChats" | "listArchivedChats">;
  readonly projects: Pick<ProjectStore, "list" | "listArchived">;
  readonly orgs: Pick<OrgStore, "get">;
  readonly orgKv: Pick<OrgKvStore, "telemetryEnabled" | "remoteImages">;
  readonly gatewayStore: Pick<GatewayStore, "listModels">;
  readonly machines: Pick<MachineStore, "listForUser">;
  readonly identity: Pick<IdentityStore, "getUser">;
}

/** The caller's active chats, newest activity first. */
export async function threadListSnapshot(ctx: Pick<WorkspaceReads, "hub" | "chats">, user: Caller): Promise<Chat[]> {
  const rows = await ctx.chats.listChats(user.org_id, user.id);
  return rows.map((chat) => chatWire(ctx.hub, chat));
}

/** The caller's archived chats, same row shape as the active list. */
export async function archivedThreadListSnapshot(
  ctx: Pick<WorkspaceReads, "hub" | "chats">,
  user: Caller,
): Promise<Chat[]> {
  const rows = await ctx.chats.listArchivedChats(user.org_id, user.id);
  return rows.map((chat) => chatWire(ctx.hub, chat));
}

/** Active and archived project rows. */
export async function projectListSnapshot(
  ctx: Pick<WorkspaceReads, "projects">,
  user: Caller,
): Promise<{ projects: ProjectRow[]; archived_projects: ProjectRow[] }> {
  const [projects, archived] = await Promise.all([
    ctx.projects.list(user.org_id, user.id),
    ctx.projects.listArchived(user.org_id, user.id),
  ]);
  return { projects, archived_projects: archived };
}

/** The workspace's display identity: the name and logo the app shell shows
 *  in its title, the admin-controlled telemetry switch and remote-image
 *  policy the clients obey, and the identity of the web bundle this server
 *  serves. */
export async function workspaceIdentitySnapshot(
  ctx: Pick<WorkspaceReads, "orgs" | "orgKv" | "config">,
  orgId: string,
): Promise<{
  name: string;
  logo_url?: string;
  telemetry: boolean;
  remote_images: RemoteImagesPolicy;
  web_bundle?: string;
}> {
  const [org, telemetry, remoteImages] = await Promise.all([
    ctx.orgs.get(orgId),
    ctx.orgKv.telemetryEnabled(orgId),
    ctx.orgKv.remoteImages(orgId),
  ]);
  const bundle = servedWebBundle(ctx.config);
  return {
    name: org.name,
    ...(org.logo_url !== null ? { logo_url: org.logo_url } : {}),
    telemetry,
    remote_images: remoteImages,
    ...(bundle !== null ? { web_bundle: bundle } : {}),
  };
}

/** The org's enabled chat models with their display names and context
 *  windows. */
export async function modelListSnapshot(
  ctx: Pick<WorkspaceReads, "gatewayStore">,
  orgId: string,
): Promise<ModelOption[]> {
  const rows = await ctx.gatewayStore.listModels(orgId);
  return rows.map((row) => ({
    id: row.model,
    alias: row.alias,
    context_window: row.context_window ?? DEFAULT_CONTEXT_WINDOW,
  }));
}

/** The member's own account: role, name, avatar and onboarding flag. */
export async function memberProfileSnapshot(ctx: Pick<WorkspaceReads, "identity">, userId: string): Promise<UserInfo> {
  return userInfo(await ctx.identity.getUser(userId));
}

/** MachineInfo wire shape. */
export function machineInfo(row: MachineRow, connected: boolean): MachineInfo {
  return {
    ...(row.app_version !== null ? { app_version: row.app_version } : {}),
    connected,
    first_connected_at: row.first_connected_at,
    last_connected_at: row.last_connected_at,
    ...(row.last_ip !== null ? { last_ip: row.last_ip } : {}),
    last_seen_at: row.last_seen_at,
    machine_id: row.machine_id,
    name: row.label !== null && row.label !== "" ? row.label : row.machine_id,
    ...(row.os !== null ? { os: row.os } : {}),
    ...(row.os_version !== null ? { os_version: row.os_version } : {}),
  };
}

/** The caller's registry rows, connected first, then by last seen. */
export async function machineListSnapshot(
  ctx: Pick<WorkspaceReads, "hub" | "machines">,
  user: Caller,
): Promise<MachineInfo[]> {
  const rows = await ctx.machines.listForUser(user.org_id, user.id);
  const list = rows.map((row) => machineInfo(row, ctx.hub.machineOnline(row.machine_id)));
  list.sort((a, b) => {
    const connectedCmp = (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
    if (connectedCmp !== 0) return connectedCmp;
    return Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at);
  });
  return list;
}
