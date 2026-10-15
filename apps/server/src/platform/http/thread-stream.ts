// GET /api/v1/chats/{id}/thread/stream — additive SSE endpoint (M3): the
// chat's ThreadState as an `data: <frame>\n\n` stream. Frames are
// byte-compatible with the member WebSocket's WsServerMsg::ThreadState (the
// M5 member socket reuses the same builders, spec §7 amendment); the SSE
// transport itself is new surface — desktop clients keep the member socket
// until the M5 cutover.
//
// Live updates ride the store NOTIFY channels (guild_thread_committed → the
// bridge committed durable output; guild_chat_status → generating flips),
// same events the Rust feed's listener consumes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatsCtx, IdentityCtx } from "../contexts.js";
import type { PlatformPool } from "../db.js";
import { requireUser } from "./error.js";
import { sseReply } from "./sse-writer.js";
import { captureThreadState, threadStateWire } from "../../chats/thread-state.js";

async function* stateFrames(
  chats: ChatsCtx,
  pool: PlatformPool,
  orgId: string,
  chatId: string,
  userId: string,
  closed: () => boolean,
): AsyncGenerator<string> {
  const initial = await captureThreadState(chats, pool, orgId, chatId, undefined);
  yield `data: ${threadStateWire(initial)}\n\n`;

  const queue: string[] = [];
  let wake: (() => void) | undefined = undefined;
  const unsubscribe = chats.notify.subscribe((channel, payload) => {
    let relevant = false;
    if (channel === "guild_thread_committed") {
      relevant = payload === chatId;
    } else if (channel === "guild_chat_status") {
      try {
        const parsed = JSON.parse(payload) as { org_id?: string; user_id?: string; chat_id?: string };
        relevant = parsed.chat_id === chatId && (parsed.org_id === undefined || parsed.org_id === orgId);
      } catch {
        relevant = false;
      }
    }
    if (!relevant) return;
    queue.push(channel);
    wake?.();
  });
  try {
    while (!closed()) {
      const channel = queue.shift();
      if (channel === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      wake = undefined;
      // A committed log or a status flip both republish the full atomic
      // view; the watermark is reserved per capture, so every frame is
      // strictly newer.
      const capture = await captureThreadState(chats, pool, orgId, chatId, undefined);
      yield `data: ${threadStateWire(capture)}\n\n`;
    }
  } finally {
    unsubscribe();
  }
  void userId;
}

export function registerThreadStreamRoute(
  app: FastifyInstance,
  chats: ChatsCtx,
  auth: IdentityCtx,
  pool: PlatformPool,
): void {
  const streamThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireUser(auth, req);
    const chatId = (req.params as { id: string }).id;
    // Owner/admin gate (404 for strangers), same as GET /thread.
    await chats.chats.getChat(user.org_id, chatId, user);
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
    });
    sseReply(reply, stateFrames(chats, pool, user.org_id, chatId, user.id, () => clientGone));
  };
  // Deprecated alias: GET /api/v1/chats/:id/thread/stream.
  app.get("/api/v1/chats/:id/thread/stream", streamThread);
  app.get("/api/v1/threads/:id/stream", streamThread);
}
