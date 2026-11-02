// Hub test env: a disposable database with every migration applied
// (`guild_hub_test_*`) and a listening app, so a ws client can dial a real
// upgrade.

import { createTestDatabase } from "./postgres.js";
import type pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { TEST_CLICKHOUSE_PASSWORD, TEST_CLICKHOUSE_USER } from "./platform-env.js";

export interface HubTestEnv {
  databaseName: string;
  databaseUrl: string;
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  /** Binds the app to an ephemeral localhost port; returns the base URL. */
  listen(): Promise<string>;
  cleanup(): Promise<void>;
}

/** `logLevel` sets the app's log level; HUB_TEST_LOG overrides it. */
export async function createHubTestEnv(logLevel = "warn"): Promise<HubTestEnv> {
  const database = await createTestDatabase("guild_hub_test_");
  const databaseName = database.name;
  const databaseUrl = new URL(database.url);
  const dbPool = database.pool;

  const config = loadConfig({
    GUILD_DATABASE_URL: databaseUrl.toString(),
    GUILD_MASTER_KEY_HEX: "33".repeat(32),
    GUILD_JWT_SECRET: "hub-test-jwt-secret",
    GUILD_CLICKHOUSE_USER: TEST_CLICKHOUSE_USER,
    GUILD_CLICKHOUSE_PASSWORD: TEST_CLICKHOUSE_PASSWORD,
    GUILD_POOL_MAX: "5",
    GUILD_API_URL: "http://localhost:18080",
    GUILD_LOG_LEVEL: process.env.HUB_TEST_LOG ?? logLevel,
  });
  const app = await buildApp(config);

  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await app.close();
    await database.drop();
  };

  return {
    databaseName,
    databaseUrl: databaseUrl.toString(),
    db: dbPool,
    app,
    config,
    listen: () =>
      new Promise<string>((resolve, reject) => {
        app
          .listen({ port: 0, host: "127.0.0.1" })
          .then(() => {
            const address = app.server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("no ephemeral port"));
              return;
            }
            resolve(`http://127.0.0.1:${address.port}`);
          })
          .catch(reject);
      }),
    cleanup,
  };
}

// ---------- scripted ws client ----------

export type FrameRecord =
  | { kind: "text"; data: string; t?: number }
  | { kind: "ping"; data: string; t?: number }
  | { kind: "pong"; data: string; t?: number }
  | { kind: "closed"; data: ""; t?: number };

/** A scripted ws client: records every inbound frame (text, ping, pong,
 *  close) in order; pongs are answered automatically so the server's
 *  heartbeat is satisfied. */
export class ScriptedClient {
  private ws!: WebSocket;
  readonly frames: FrameRecord[] = [];
  private openPromise: Promise<void>;
  private closedPromise: Promise<void>;

  constructor(url: string) {
    this.openPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on("open", resolve);
      this.ws.on("error", (err) => reject(err));
      this.ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return; // binary frames are ignored by both implementations
        this.frames.push({ kind: "text", data: data.toString("utf8"), t: Date.now() });
      });
      this.ws.on("ping", (data: Buffer) => {
        this.frames.push({ kind: "ping", data: data.toString("hex") });
        this.ws.pong(data, true, () => {});
      });
      this.ws.on("pong", (data: Buffer) => {
        this.frames.push({ kind: "pong", data: data.toString("hex") });
      });
      this.ws.on("close", () => {
        this.frames.push({ kind: "closed", data: "", t: Date.now() });
        this.closedResolve?.();
      });
    });
    this.closedPromise = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  private closedResolve: (() => void) | undefined;

  async open(): Promise<void> {
    await this.openPromise;
  }

  async closed(): Promise<void> {
    await this.closedPromise;
  }

  send(text: string): void {
    this.ws.send(text);
  }

  end(): Promise<void> {
    this.ws.close();
    return this.closedPromise;
  }

  /** Waits until `predicate` matches a recorded text frame (or timeout). */
  async until(predicate: (frame: FrameRecord) => boolean, timeoutMs = 15_000): Promise<FrameRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`frame not found within ${timeoutMs}ms: frames=${JSON.stringify(this.frames)}`);
  }
}
