// The file tools' one binding: a per-call `machine` target that swaps the
// call's environment, and no target without it.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createRoutedCodingTools } from "../../harness/agent-tools.js";
import { MachineTargetError } from "../../machines/targets.js";

function env() {
  return new NodeExecutionEnv({ cwd: mkdtempSync(path.join(tmpdir(), "guild-agent-tools-")) });
}

const routed = (envFor: (request: unknown) => Promise<NodeExecutionEnv>) =>
  createRoutedCodingTools({ chatId: "chat-1", orgId: "org-1", userId: "user-1", envFor: envFor as never });

describe("createRoutedCodingTools", () => {
  it("keeps the plain names and offers machine and cwd", () => {
    const tools = routed(async () => env());
    expect(tools.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
    for (const tool of tools) {
      const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).toContain("machine");
      expect(Object.keys(properties)).toContain("cwd");
    }
  });

  it("without machine, runs in the call's own environment", async () => {
    let asked = 0;
    const [, write] = routed(async () => {
      asked += 1;
      return env();
    });
    const sandbox = env();
    await write!.execute({ path: "a.md", content: "hi" }, { env: sandbox } as never, {} as never);
    expect(asked).toBe(0);
  });

  it("with machine, runs in the resolved env and strips the target from the args", async () => {
    const seen: unknown[] = [];
    const sandbox = env();
    const target = env();
    const [, write] = routed(async (request) => {
      seen.push(request);
      return target;
    });
    await write!.execute(
      { path: "a.md", content: "hi", machine: "MacBook", cwd: "/work" },
      { env: sandbox } as never,
      {} as never,
    );
    expect(seen).toEqual([{ chatId: "chat-1", orgId: "org-1", userId: "user-1", machine: "MacBook", cwd: "/work" }]);
    // The file landed in the target env, not in the call's own env.
    expect((await target.readTextFile(path.join(target.cwd, "a.md"), {} as never)).ok).toBe(true);
    expect((await sandbox.readTextFile(path.join(sandbox.cwd, "a.md"), {} as never)).ok).toBe(false);
  });

  it("cwd without machine is an error result", async () => {
    const [, write] = routed(async () => env());
    const out = (await write!.execute(
      { path: "a.md", content: "x", cwd: "/work" },
      { env: env() } as never,
      {} as never,
    )) as {
      isError?: boolean;
      output: { text: string }[];
    };
    expect(out.isError).toBe(true);
    expect(out.output[0]!.text).toContain("cwd needs machine");
  });

  it("an unaddressable machine is an error result, not a throw", async () => {
    const [, write] = routed(async () => {
      throw new MachineTargetError('no such machine: "laptop"');
    });
    const out = (await write!.execute(
      { path: "a.md", content: "x", machine: "laptop" },
      { env: env() } as never,
      {} as never,
    )) as {
      isError?: boolean;
      output: { text: string }[];
    };
    expect(out.isError).toBe(true);
    expect(out.output[0]!.text).toContain("no such machine");
  });
});
