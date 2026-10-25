// Workspace snapshots: the sidebar's whole live state — active chats,
// archived chats, projects, and the machine registry. The feed pushes them
// together on every workspace change, so no client reads them over HTTP.

import type { PlatformContext } from "../platform/root-context.js";
import type { UserRow } from "../platform/store/identity.js";
import type { MachineRow } from "../platform/store/machines.js";
import type { ProjectRow } from "../platform/store/projects.js";
import type { ChatListRow } from "../platform/store/chats.js";

type Caller = Pick<UserRow, "org_id" | "id">;

/** One chat row in the sidebar wire shape. Key order is alphabetical: the
 *  Rust feed built rows through serde_json::Value (BTreeMap), and the
 *  golden capture pins that order. */
function chatRow(ctx: PlatformContext, chat: ChatListRow): Record<string, unknown> {
  const online = chat.machine_id !== null && ctx.hub.machineOnline(chat.machine_id);
  // Old chats stored the raw machine id as their label; the live hub label
  // (the machine's hostname) is the truth when the slot is up.
  const label =
    online && chat.machine_id !== null
      ? (ctx.hub.machineLabel(chat.machine_id) ?? chat.machine_id)
      : chat.machine_label;
  return {
    blocked: chat.blocked,
    created_at: chat.created_at,
    generating: chat.generating,
    id: chat.id,
    last_activity_at: chat.last_activity_at,
    ...(chat.machine_id !== null ? { machine_id: chat.machine_id } : {}),
    ...(label !== null ? { machine_label: label } : {}),
    machine_online: online,
    org_id: chat.org_id,
    ...(chat.project_id !== null ? { project_id: chat.project_id } : {}),
    ...(chat.project_name !== null ? { project_name: chat.project_name } : {}),
    ...(chat.project_machine_label !== null
      ? { project_machine_label: chat.project_machine_label }
      : {}),
    ...(chat.title !== null ? { title: chat.title } : {}),
    unread: chat.unread,
    user_id: chat.user_id,
    working: chat.working,
  };
}

/** The caller's active chats, newest activity first. */
export async function threadListSnapshot(
  ctx: PlatformContext,
  user: Caller,
): Promise<unknown[]> {
  const rows = await ctx.chats.listChats(user.org_id, user.id);
  return rows.map((chat) => chatRow(ctx, chat));
}

/** The caller's archived chats, same row shape as the active list. */
export async function archivedThreadListSnapshot(
  ctx: PlatformContext,
  user: Caller,
): Promise<unknown[]> {
  const rows = await ctx.chats.listArchivedChats(user.org_id, user.id);
  return rows.map((chat) => chatRow(ctx, chat));
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

/** MachineInfo wire shape. Alphabetical key order, same reason as the chat
 *  rows. */
export function machineInfo(row: MachineRow, connected: boolean): Record<string, unknown> {
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
): Promise<unknown[]> {
  const rows = await ctx.machines.listForUser(user.org_id, user.id);
  const list = rows.map((row) => machineInfo(row, ctx.hub.machineOnline(row.machine_id)));
  list.sort((a, b) => {
    const connectedCmp = (b.connected as boolean ? 1 : 0) - (a.connected as boolean ? 1 : 0);
    if (connectedCmp !== 0) return connectedCmp;
    return Date.parse(b.last_seen_at as string) - Date.parse(a.last_seen_at as string);
  });
  return list;
}
