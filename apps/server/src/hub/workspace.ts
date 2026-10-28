// Workspace snapshots: the sidebar's whole live state — active chats,
// archived chats, projects, and the machine registry. The feed pushes them
// together on every workspace change, so no client reads them over HTTP.

import type { PlatformContext } from "../platform/root-context.js";
import type { UserRow } from "../platform/store/identity.js";
import type { MachineRow } from "../platform/store/machines.js";
import type { ProjectRow } from "../platform/store/projects.js";
import type { Chat, MachineInfo } from "@guild/wire/rest";
import { chatWire } from "../chats/chat-wire.js";

type Caller = Pick<UserRow, "org_id" | "id">;

/** The caller's active chats, newest activity first. */
export async function threadListSnapshot(
  ctx: PlatformContext,
  user: Caller,
): Promise<Chat[]> {
  const rows = await ctx.chats.listChats(user.org_id, user.id);
  return rows.map((chat) => chatWire(ctx.hub, chat));
}

/** The caller's archived chats, same row shape as the active list. */
export async function archivedThreadListSnapshot(
  ctx: PlatformContext,
  user: Caller,
): Promise<Chat[]> {
  const rows = await ctx.chats.listArchivedChats(user.org_id, user.id);
  return rows.map((chat) => chatWire(ctx.hub, chat));
}

/** Active and archived project rows. */
export async function projectListSnapshot(
  ctx: PlatformContext,
  user: Caller,
): Promise<{ projects: ProjectRow[]; archived_projects: ProjectRow[] }> {
  const [projects, archived] = await Promise.all([
    ctx.projects.list(user.org_id, user.id),
    ctx.projects.listArchived(user.org_id, user.id),
  ]);
  return { projects, archived_projects: archived };
}

/** The workspace's display identity: the name and logo the app shell shows
 *  in its title. */
export async function workspaceIdentitySnapshot(
  ctx: PlatformContext,
  orgId: string,
): Promise<{ name: string; logo_url?: string }> {
  const org = await ctx.orgs.get(orgId);
  return org.logo_url === null
    ? { name: org.name }
    : { name: org.name, logo_url: org.logo_url };
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
  ctx: PlatformContext,
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
