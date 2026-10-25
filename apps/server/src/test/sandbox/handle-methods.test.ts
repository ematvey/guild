// The typed handle proxy in SandboxExecutionEnv repeats the method list in
// HANDLE_METHODS. This test walks the wire table and asserts the proxy
// answers every method it names, so a new handle method cannot land in one
// copy only.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Result } from "@earendil-works/pi-durable/env";
import { SandboxExecutionEnv } from "../../sandbox/env.js";
import { HANDLE_METHODS, wirePair, type HandleKind } from "../../sandbox/protocol.js";
import { serveEnv } from "../../sandbox/serve.js";

function unwrap<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`handle open failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("sandbox handle proxy", () => {
  it("exposes every method HANDLE_METHODS names for its handle kind", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-sbx-handles-"));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "file.txt"), "one\ntwo\n");
    const served: Promise<void>[] = [];
    const env = new SandboxExecutionEnv({
      id: "sandbox:test",
      cwd: dir,
      connect: async () => {
        const [client, agent] = wirePair();
        served.push(serveEnv(new NodeExecutionEnv({ cwd: dir }), agent));
        return client;
      },
    });
    try {
      const handles: Record<HandleKind, object> = {
        textLineReader: unwrap(await env.openTextLineReader(path.join(dir, "file.txt"), BACKGROUND_CONTEXT)),
        binaryReader: unwrap(await env.openBinaryReader(path.join(dir, "file.txt"), undefined, BACKGROUND_CONTEXT)),
        dirReader: unwrap(await env.openDirReader(path.join(dir, "sub"), BACKGROUND_CONTEXT)),
        watcher: unwrap(await env.watch([{ path: dir }], () => {}, BACKGROUND_CONTEXT)),
      };
      for (const [kind, methods] of Object.entries(HANDLE_METHODS)) {
        const handle = handles[kind as HandleKind] as Record<string, unknown>;
        for (const method of methods) {
          expect(typeof handle[method], `${kind}.${method}`).toBe("function");
        }
      }
      for (const handle of Object.values(handles) as { close(context: typeof BACKGROUND_CONTEXT): Promise<void> }[]) {
        await handle.close(BACKGROUND_CONTEXT);
      }
    } finally {
      env.disconnect();
      await Promise.all(served);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
