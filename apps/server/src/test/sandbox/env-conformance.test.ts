// pi-durable's ExecutionEnv conformance suite against SandboxExecutionEnv
// talking to an in-process agent over an in-memory wire: proves the RPC
// proxy is faithful to NodeExecutionEnv (readers, watchers, exec output,
// abort, spill).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { SandboxExecutionEnv } from "../../sandbox/env.js";
import { wirePair } from "../../sandbox/protocol.js";
import { serveEnv } from "../../sandbox/serve.js";

const cases = createEnvConformance({
  assertions: {
    ok: (value, message) => assert.ok(value, message),
    strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
    deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
    partialDeepEqual: (actual, expected) => {
      for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
        assert.deepStrictEqual((actual as Record<string, unknown>)[k], v);
      }
    },
    greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
    rejects: async (operation, messageIncludes) => {
      await assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes));
    },
  },
  withEnv: async (use) => {
    const dir = mkdtempSync(path.join(tmpdir(), "guild-sbx-conf-"));
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
      await use(env);
    } finally {
      env.disconnect();
      await Promise.all(served);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

describe("SandboxExecutionEnv conformance", () => {
  for (const c of cases) {
    it(c.name, { timeout: c.timeoutMs ?? 20_000 }, () => c.run());
  }
});
