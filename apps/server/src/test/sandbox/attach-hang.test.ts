// A sandbox that never opens must fail the tool call, not hold the turn
// open: the attach handshake is bounded, and a caller that aborts stops
// waiting for the runner even while the shared connect is still pending.

import http from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { RunnerClient } from "../../sandbox/client.js";
import { SandboxExecutionEnv } from "../../sandbox/env.js";

/** Accepts the upgrade request and never answers it. */
function hangingServer(): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((_req, res) => res.end());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", () => {
    // Deliberately no response: the client must give up on its own.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

describe("sandbox attach", () => {
  it("rejects a handshake the runner never answers", async () => {
    const server = await hangingServer();
    try {
      const client = new RunnerClient(server.url, "token", 200);
      await assert.rejects(client.connect("sandbox"), /timed out/);
    } finally {
      server.close();
    }
  });

  it("rejects a refused handshake", async () => {
    const server = await hangingServer();
    const url = server.url;
    server.close();
    const client = new RunnerClient(url, "token", 5_000);
    await assert.rejects(client.connect("sandbox"));
  });

  it("returns from a call whose context aborts during connect", async () => {
    const env = new SandboxExecutionEnv({
      id: "sandbox:hang",
      cwd: "/workspace",
      // Never settles: the runner is wedged and the socket never opens.
      connect: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    const pending = env.exec("ls", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    controller.abort(new Error("stopped"));
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /aborted/);
  });
});
