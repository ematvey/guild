// One forked worker process: owns one chat's conversation end to end —
// scoped durable harness, bridge, codemode sandbox, executor envs — and
// serves admission + control over the supervisor's IPC protocol. Frames
// and approval decisions cross the boundary through Postgres (thread_events
// + pg_notify; the gate's journaled decision poll), not through here.

import pino from "pino";
import { ObjectStore } from "../platform/s3.js";
import { createPlatformPool } from "../platform/db.js";
import { GuildRuntime } from "../harness/runtime.js";
import { loadConfig } from "../config.js";
import type { WorkerRequest } from "./protocol.js";

const config = loadConfig(process.env);
const log = pino({ level: config.logLevel });

const chatId = process.env.GUILD_WORKER_CHAT_ID;
if (!chatId) throw new Error("GUILD_WORKER_CHAT_ID is not set — this entry is forked by the supervisor only");

const pool = createPlatformPool(config.databaseUrl, config.poolMax);
const objects = new ObjectStore(config);
const runtime = new GuildRuntime(config, pool, log, objects, undefined, undefined, undefined, undefined, {
  chatId,
});

let heartbeat: NodeJS.Timeout | undefined;

async function shutdown(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  await runtime.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

// The parent going away (crash, redeploy, close) orphans this worker: exit
// cleanly — the scoped harness close leaves pending work pending, and the
// supervisor's respawn (or the next touch) resumes it.
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function send(message: unknown): void {
  if (process.connected) process.send!(message);
}

async function main(): Promise<void> {
  await runtime.start();
  heartbeat = setInterval(() => send({ t: "heartbeat" }), 15_000);
  heartbeat.unref?.();
  send({ t: "ready" });
  log.info({ chatId }, "worker ready");
}

process.on("message", (raw: unknown) => {
  const message = raw as WorkerRequest;
  if (!message || typeof message !== "object" || !("t" in message)) return;
  void (async () => {
    try {
      let data: unknown;
      switch (message.t) {
        case "submit":
          data = await runtime.submitTurn(chatId, message.input.orgId, message.input);
          break;
        case "withdraw":
          data = await runtime.withdrawQueued(chatId, message.submissionId);
          break;
        case "stop":
          await runtime.stopChat(chatId);
          data = null;
          break;
        case "compact":
          data = await runtime.compactChat(chatId);
          break;
      }
      send({ t: "result", ref: message.ref, ok: true, data });
    } catch (error) {
      send({ t: "result", ref: message.ref, ok: false, error: (error as Error)?.message ?? String(error) });
      log.error({ err: error, chatId, kind: message.t }, "worker request failed");
    }
  })();
});

void main().catch((error) => {
  log.error({ err: error, chatId }, "worker failed to start");
  process.exit(1);
});
