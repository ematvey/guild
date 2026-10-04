// M5 hub-core test harness: disposable Postgres database (verbatim Rust
// migrations applied in order, namespaced `guild_m5_test_*`) + a listening
// app instance so the ws client can dial a real upgrade.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { MIGRATIONS_DIR, TEST_ADMIN_URL } from "./harness.js";

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface M5TestEnv {
  databaseName: string;
  databaseUrl: string;
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  /** Binds the app to an ephemeral localhost port; returns the base URL. */
  listen(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createM5TestEnv(_logLevel = "error"): Promise<M5TestEnv> {
  const suffix = randomSuffix();
  const databaseName = `guild_m5_test_${suffix}`;

  const adminPool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  await adminPool.end();
  const databaseUrl = new URL(TEST_ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;

  // Seeding/preparation pool on the disposable database — never on the
  // shared guild database the admin URL points at.
  const dbPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4, idleTimeoutMillis: 2000 });

  const migrationPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2, idleTimeoutMillis: 2000 });
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    await migrationPool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  await migrationPool.end();

  const config = loadConfig({
    GUILD_DATABASE_URL: databaseUrl.toString(),
    GUILD_MASTER_KEY_HEX: "33".repeat(32),
    GUILD_JWT_SECRET: "m5-test-jwt-secret",
    GUILD_POOL_MAX: "5",
    GUILD_API_URL: "http://localhost:18080",
    GUILD_LOG_LEVEL: process.env.M5_TEST_LOG ?? "warn",
  });
  const app = await buildApp(config);

  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await app.close();
    await dbPool.end();
    const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
    try {
      // WITH (FORCE) can transiently fail ("permission denied to terminate
      // process") when a backend exits as the signal lands under load —
      // retry (the m2-harness cleanup does the same).
      for (let attempt = 1; ; attempt++) {
        try {
          await dropper.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
          break;
        } catch (error) {
          if (attempt >= 4) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("terminate process")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    } finally {
      await dropper.end();
    }
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
