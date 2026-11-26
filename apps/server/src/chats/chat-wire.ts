// The one builder for the REST `Chat` row. The HTTP thread routes and the
// member socket's thread_list push both use it, so a single shape reaches
// both surfaces.

import type { Chat } from "@guild/wire/rest";
import type { ChatListRow } from "../platform/store/chats.js";

/** The two hub reads the row's machine liveness depends on. */
export interface ChatWireHub {
  machineOnline(machineId: string): boolean;
  machineLabel(machineId: string): string | undefined;
}

/** protocol::api::Chat. */
export function chatWire(hub: ChatWireHub, row: ChatListRow): Chat {
  const online = row.machine_id !== null && hub.machineOnline(row.machine_id);
  // The live hub label (the machine's hostname) is the truth when the slot is
  // up; otherwise the stored label stands.
  const label =
    online && row.machine_id !== null ? (hub.machineLabel(row.machine_id) ?? row.machine_id) : row.machine_label;
  return {
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
    ...(row.title !== null ? { title: row.title } : {}),
    created_at: row.created_at,
    ...(row.machine_id !== null ? { machine_id: row.machine_id } : {}),
    ...(label !== null ? { machine_label: label } : {}),
    generating: row.generating,
    unread: row.unread,
    working: row.working,
    blocked: row.blocked,
    last_activity_at: row.last_activity_at,
    ...(row.project_id !== null ? { project_id: row.project_id } : {}),
    ...(row.project_name !== null ? { project_name: row.project_name } : {}),
    ...(row.project_machine_label !== null ? { project_machine_label: row.project_machine_label } : {}),
    machine_online: online,
    type: row.type,
    ...(row.pin_rank !== undefined ? { pin_rank: row.pin_rank } : {}),
    ...(row.pinned_at ? { pinned_at: row.pinned_at } : {}),
    ...(row.shared_agent_inbox ? { shared_agent_inbox: true } : {}),
    ...(row.assistant_inbox ? { assistant_inbox: true } : {}),
    archived: row.archived,
    deleted: row.deleted,
    ...(row.routine !== null ? { routine: row.routine } : {}),
  };
}
