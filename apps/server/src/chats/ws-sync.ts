// The member socket's state-sync capture (Rust feed::run_sync_started's
// capture_thread): one chat's durable history + in-flight buffers as the
// authoritative ThreadState frame, owner/admin gated (the caller argument).
// Wired onto PlatformContext.wsSync inside the socket's sync bracket.

import type { PlatformContext } from "../platform/context.js";
import type { UserRow } from "../platform/store/identity.js";
import type { WsServerMsg } from "../hub/protocol.js";
import { captureThreadState, threadStateMsg } from "./thread-state.js";

/** Installs the sync seam: a `sync` client message answers SyncBegin →
 *  ThreadState → SyncDone (errors ride an Error frame inside the bracket —
 *  http/ws.ts owns the bracket). */
export function wireWsSync(ctx: PlatformContext): void {
  ctx.wsSync = async (args: { chatId: string; user: UserRow }): Promise<WsServerMsg> => {
    const capture = await captureThreadState(ctx, ctx.pool, args.user.org_id, args.chatId, args.user);
    return threadStateMsg(capture);
  };
}
