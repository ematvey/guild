// guild-sandbox-runner: the only process holding the Docker socket. Serves
// a token-authenticated HTTP API on the compose network (never published)
// and bridges RPC WebSockets to agent processes inside sandboxes.

import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import { pino, type Logger } from "pino";
import { WebSocketServer } from "ws";
import { LineSplitter } from "../protocol.js";
import { DockerClient } from "./docker.js";
import { RunnerError, SandboxManager } from "./manager.js";
import { loadRunnerConfig } from "./spec.js";

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new RunnerError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new RunnerError(400, "invalid JSON body");
  }
}

export function createRunnerServer(manager: SandboxManager, log: Logger): http.Server {
  const { token } = manager.config;
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://runner");
      if (!authorized(req, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/v1/healthz") {
        return send(res, 200, {
          ok: true,
          runtime: manager.config.runtime,
          image: manager.config.image,
          network: manager.config.network,
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
        const body = await readJson(req);
        const key = body["key"];
        const subpath = body["subpath"];
        if (typeof key !== "string" || typeof subpath !== "string")
          throw new RunnerError(400, "key and subpath are required");
        return send(res, 200, await manager.ensure(key, subpath));
      }
      if (req.method === "DELETE" && url.pathname === "/v1/sandboxes") {
        const key = url.searchParams.get("key");
        if (key === null) throw new RunnerError(400, "key is required");
        await manager.removeByKey(key);
        return send(res, 200, { ok: true });
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(\/stop)?$/.exec(url.pathname);
      if (match && req.method === "POST" && match[2] === "/stop") {
        await manager.stopSandbox(match[1]!);
        return send(res, 200, { ok: true });
      }
      if (match && req.method === "DELETE" && match[2] === undefined) {
        await manager.removeSandbox(match[1]!);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    })().catch((error: unknown) => {
      if (error instanceof RunnerError) return send(res, error.status, { error: error.message });
      log.error({ err: error }, "runner request failed");
      send(res, 500, { error: "internal" });
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://runner");
    const match = /^\/v1\/sandboxes\/([^/]+)\/rpc$/.exec(url.pathname);
    if (!authorized(req, token) || !match) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const name = match[1]!;
    void manager.attach(name).then(
      ({ stream, release }) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const splitter = new LineSplitter();
          stream.onStdout((chunk) => splitter.push(chunk, (line) => ws.send(line)));
          stream.onStderr((chunk) => log.warn({ name, stderr: chunk.toString("utf8").slice(0, 2000) }, "agent stderr"));
          stream.onEnd(() => {
            release();
            ws.close();
          });
          ws.on("message", (data) => {
            stream.stdin.write(data as Buffer);
            stream.stdin.write("\n");
          });
          ws.on("close", () => {
            release();
            stream.close();
          });
        });
      },
      (error: unknown) => {
        const status = error instanceof RunnerError ? error.status : 500;
        log.warn({ err: error, name }, "agent attach failed");
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n\r\n`);
      },
    );
  });
  return server;
}

/** The runner's compose project, from its own container's labels. */
async function discoverProject(docker: DockerClient): Promise<string | null> {
  try {
    const self = await docker.request<{ Config: { Labels: Record<string, string> } }>(
      "GET",
      `/containers/${os.hostname()}/json`,
    );
    return self.Config.Labels["com.docker.compose.project"] ?? null;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const log = pino({ level: process.env.GUILD_LOG_LEVEL ?? "info", base: { service: "sandbox-runner" } });
  const docker = new DockerClient(process.env.GUILD_SANDBOX_DOCKER_SOCKET ?? "/var/run/docker.sock");
  const config = loadRunnerConfig(process.env, { project: await discoverProject(docker) });
  const manager = new SandboxManager(config, docker, log);
  await manager.start();
  const server = createRunnerServer(manager, log);
  server.listen(config.port, () =>
    log.info(
      {
        port: config.port,
        project: config.project,
        runtime: config.runtime,
        volume: config.volume,
        network: config.network,
      },
      "sandbox runner listening",
    ),
  );
  const shutdown = () => {
    manager.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
