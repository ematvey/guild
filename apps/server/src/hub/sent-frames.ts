// What each socket last received of every whole-value frame. A push sends a
// frame only when its content differs from the one that socket already
// holds, so a write that leaves a reader's filtered view unchanged costs that
// reader nothing, and a list change that moves one row sends that row.
// Every send of a keyed frame goes through here: a send that bypassed the
// record would let a later identical-looking value be skipped wrongly.

import type { Chat } from "@guild/wire/rest";
import type { SocketSink } from "./sink.js";
import type { WsServerMsg } from "./protocol.js";

/** The client applies `chat_row` (the upgrade query's `features`). */
export const CHAT_ROW_FEATURE = "chat_row";

/** More changed rows than this send the whole list instead. */
const MAX_ROW_FRAMES = 8;

/** The part of a socket these sends use: its queue and declared features. */
type Sink = Pick<SocketSink, "send"> & { readonly features?: ReadonlySet<string> };

interface ChatListRecord {
  order: string;
  rows: Map<string, string>;
}

const frames = new WeakMap<Sink, Map<string, string>>();
const chatLists = new WeakMap<Sink, ChatListRecord>();

/** Sends a changed frame, or always sends a requested sync seed. Returns
 *  whether the frame was sent. */
export function sendChanged(sink: Sink, key: string, frame: WsServerMsg, force = false): boolean {
  const wire = JSON.stringify(frame);
  let byKey = frames.get(sink);
  if (byKey === undefined) {
    byKey = new Map();
    frames.set(sink, byKey);
  }
  if (!force && byKey.get(key) === wire) return false;
  if (!sink.send(frame)) return false;
  byKey.set(key, wire);
  return true;
}

/** Sends the active chat list as the smallest change from what the socket
 *  holds: nothing when no row moved; `chat_row` frames when only some rows
 *  changed in place (rows and order kept) and the client applies them;
 *  otherwise the whole `thread_list`. Returns the frames sent. */
export function sendChatList(sink: Sink, chats: Chat[]): number {
  const rows = new Map(chats.map((chat) => [chat.id, JSON.stringify(chat)]));
  const order = chats.map((chat) => chat.id).join(",");
  const prior = chatLists.get(sink);
  if (prior !== undefined && prior.order === order) {
    const changed = chats.filter((chat) => prior.rows.get(chat.id) !== rows.get(chat.id));
    if (changed.length === 0) return 0;
    if (sink.features?.has(CHAT_ROW_FEATURE) === true && changed.length <= MAX_ROW_FRAMES) {
      let sent = 0;
      for (const chat of changed) {
        if (!sink.send({ type: "chat_row", chat })) break;
        prior.rows.set(chat.id, rows.get(chat.id)!);
        sent += 1;
      }
      return sent;
    }
  }
  if (!sink.send({ type: "thread_list", chats })) return 0;
  chatLists.set(sink, { order, rows });
  return 1;
}
