// The runner's container policy (no Docker): what a request can and cannot
// influence, and the config the runner refuses to start with.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { containerName, containerSpec, loadRunnerConfig, validKey, validSubpath } from "../../sandbox/runner/spec.js";
import { SandboxManager } from "../../sandbox/runner/manager.js";
import { DockerError, type DockerClient } from "../../sandbox/runner/docker.js";
import { decodeValue, encodeValue, LineSplitter } from "../../sandbox/protocol.js";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";

// A dead JuiceFS mount answers ENOTCONN from any fs call on the volume, and
// only a fresh runner container re-resolves the mount. Every other path in
// this file keeps the real implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (p: Parameters<typeof real.mkdir>[0], o?: Parameters<typeof real.mkdir>[1]) => {
      if (String(p).endsWith("/deadmount")) {
        throw Object.assign(new Error(`ENOTCONN: socket is not connected, mkdir '${String(p)}'`), { code: "ENOTCONN" });
      }
      return real.mkdir(p, o);
    },
  };
});

const ORG = "0194a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const AGENT = "0194a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const env = {
  GUILD_SANDBOX_RUNNER_TOKEN: "x".repeat(32),
  GUILD_SANDBOX_PROXY_URL: "http://10.213.0.2:3128",
};

describe("subpath and key validation", () => {
  it("accepts only workspaces/<org>/<name>, chats/<org>/<id> and agents/<org>/<agent>", () => {
    expect(validSubpath(`workspaces/${ORG}/repo-1`)).toBe(true);
    expect(validSubpath(`chats/${ORG}/42`)).toBe(true);
    expect(validSubpath(`agents/${ORG}/${AGENT}`)).toBe(true);
    for (const bad of [
      "../etc",
      `workspaces/${ORG}/..`,
      `workspaces/${ORG}/.`,
      `workspaces/${ORG}/a/b`,
      `workspaces/${ORG}/../${ORG}/x`,
      `/workspaces/${ORG}/x`,
      `workspaces/${ORG}/`,
      `workspaces/not-a-uuid!/x`,
      `other/${ORG}/x`,
      `workspaces/${ORG}/x\n`,
      `agents/${ORG}`,
      `agents/${ORG}/not-a-uuid`,
      `agents/${ORG}/a/b`,
      `agents/${ORG}/../${ORG}/x`,
    ]) {
      expect(validSubpath(bad), bad).toBe(false);
    }
    expect(validKey(`ws:${ORG}:repo-1`)).toBe(true);
    expect(validKey(`agent:${ORG}:${AGENT}`)).toBe(true);
    expect(validKey("bad key")).toBe(false);
  });
});

describe("container spec", () => {
  const config = loadRunnerConfig(env, { project: "compose" });

  it("fixes runtime, user, network, mounts and limits from config", () => {
    const spec = containerSpec(config, `ws:${ORG}:r`, `workspaces/${ORG}/r`) as {
      User: string;
      Env: string[];
      HostConfig: Record<string, unknown> & { Mounts: Array<Record<string, unknown>> };
    };
    expect(spec.User).toBe("1000:1000");
    expect(spec.HostConfig["Runtime"]).toBe("runsc");
    expect(spec.HostConfig["NetworkMode"]).toBe("compose_sandbox");
    expect(spec.HostConfig["ReadonlyRootfs"]).toBe(true);
    expect(spec.HostConfig["CapDrop"]).toEqual(["ALL"]);
    expect(spec.HostConfig["SecurityOpt"]).toEqual(["no-new-privileges"]);
    expect(spec.HostConfig["Privileged"]).toBeUndefined();
    expect(spec.HostConfig["Binds"]).toBeUndefined();
    expect(spec.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "compose_guild_data",
        Target: "/workspace",
        VolumeOptions: { Subpath: `workspaces/${ORG}/r`, NoCopy: true },
      },
    ]);
    expect(spec.Env.some((e) => e.startsWith("GUILD_SANDBOX_RUNNER_TOKEN"))).toBe(false);
    expect(spec.Env).toContain("HTTPS_PROXY=http://10.213.0.2:3128");
  });

  it("drops proxy settings in none mode", () => {
    const none = loadRunnerConfig({ ...env, GUILD_SANDBOX_NETWORK_MODE: "none" }, { project: "compose" });
    const spec = containerSpec(none, `ws:${ORG}:r`, `workspaces/${ORG}/r`) as {
      Env: string[];
      NetworkDisabled: boolean;
      HostConfig: Record<string, unknown>;
    };
    expect(spec.NetworkDisabled).toBe(true);
    expect(spec.HostConfig["NetworkMode"]).toBe("none");
    expect(spec.Env.some((e) => /proxy/i.test(e))).toBe(false);
  });

  it("mounts the agent volume for agents/ subpaths", () => {
    const spec = containerSpec(config, `agent:${ORG}:${AGENT}`, `agents/${ORG}/${AGENT}`) as {
      Labels: Record<string, string>;
      HostConfig: { Mounts: Array<Record<string, unknown>> };
    };
    expect(spec.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "compose_guild_workspaces",
        Target: "/workspace",
        VolumeOptions: { Subpath: `agents/${ORG}/${AGENT}`, NoCopy: true },
      },
    ]);
    expect(spec.Labels["guild.sandbox.subpath"]).toBe(`agents/${ORG}/${AGENT}`);
  });

  it("reads the agent volume and its runner mount from env", () => {
    const custom = loadRunnerConfig(
      { ...env, GUILD_SANDBOX_AGENT_VOLUME: "juice_guild_workspaces", GUILD_SANDBOX_AGENT_DIR: "/mnt/agents" },
      { project: "compose" },
    );
    expect(custom.agentVolume).toBe("juice_guild_workspaces");
    expect(custom.agentDataDir).toBe("/mnt/agents");
    expect(containerSpec(custom, `agent:${ORG}:${AGENT}`, `agents/${ORG}/${AGENT}`)).toMatchObject({
      HostConfig: { Mounts: [{ Source: "juice_guild_workspaces" }] },
    });
  });

  it("names containers per project and key", () => {
    expect(containerName({ project: "compose" }, "a")).toMatch(/^guild-sbx-compose-[0-9a-f]{20}$/);
    expect(containerName({ project: "compose" }, "a")).not.toBe(containerName({ project: "guild-live" }, "a"));
  });

  it("refuses to start without a token or with a proxy named by hostname", () => {
    expect(() => loadRunnerConfig({}, { project: null })).toThrow(/TOKEN/);
    expect(() =>
      loadRunnerConfig({ ...env, GUILD_SANDBOX_PROXY_URL: "http://egress:3128" }, { project: null }),
    ).toThrow(/IP address/);
    expect(() => loadRunnerConfig({ GUILD_SANDBOX_RUNNER_TOKEN: "x".repeat(32) }, { project: null })).toThrow(
      /PROXY_URL/,
    );
  });
});

describe("always-on agent sandboxes", () => {
  const config = loadRunnerConfig(env, { project: "compose" });
  const log = pino({ level: "silent" });

  it("removes the sandboxes a previous runner left behind", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "guild-runner-start-"));
    const boot = loadRunnerConfig(
      { ...env, GUILD_SANDBOX_DATA_DIR: root, GUILD_SANDBOX_AGENT_DIR: path.join(root, "agents") },
      { project: "compose" },
    );
    const calls: string[] = [];
    const containers = [
      { Id: "1", Names: ["/guild-sbx-compose-aaaaaaaaaaaaaaaaaaaa"], State: "running", Labels: {} },
      { Id: "2", Names: ["/guild-sbx-compose-bbbbbbbbbbbbbbbbbbbb"], State: "running", Labels: {} },
    ];
    const docker = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === "/info") return { Runtimes: { runsc: {} } };
        if (path.startsWith("/images/")) return {};
        if (path.startsWith("/containers/json")) return containers;
        return {};
      },
    } as unknown as DockerClient;
    const manager = new SandboxManager(boot, docker, log);
    await manager.start();
    manager.stop();
    expect(calls).toContain("DELETE /containers/guild-sbx-compose-aaaaaaaaaaaaaaaaaaaa?force=true");
    expect(calls).toContain("DELETE /containers/guild-sbx-compose-bbbbbbbbbbbbbbbbbbbb?force=true");
  });

  it("reap skips agent sandboxes but still stops idle chats", async () => {
    const calls: string[] = [];
    const containers = [
      {
        Id: "1",
        Names: ["/guild-sbx-compose-aaaaaaaaaaaaaaaaaaaa"],
        State: "running",
        Labels: { "guild.sandbox.subpath": `agents/${ORG}/${AGENT}` },
      },
      {
        Id: "2",
        Names: ["/guild-sbx-compose-bbbbbbbbbbbbbbbbbbbb"],
        State: "stopped",
        Labels: { "guild.sandbox.subpath": `agents/${ORG}/${AGENT}` },
      },
      {
        Id: "3",
        Names: ["/guild-sbx-compose-cccccccccccccccccccc"],
        State: "running",
        Labels: { "guild.sandbox.subpath": `chats/${ORG}/42` },
      },
    ];
    const docker = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path.startsWith("/containers/json")) return containers;
        return {};
      },
    } as unknown as DockerClient;
    const manager = new SandboxManager(config, docker, log);
    await manager.reap(Date.now() + config.idleRemoveMs * 2);
    expect(calls.some((c) => c.includes("aaaaaaaaaaaaaaaaaaaa"))).toBe(false);
    expect(calls.some((c) => c.includes("bbbbbbbbbbbbbbbbbbbb"))).toBe(false);
    expect(calls.some((c) => c.includes("cccccccccccccccccccc") && c.includes("/stop"))).toBe(true);
  });

  it("attach removes a sandbox whose workspace mount died", async () => {
    const name = "guild-sbx-compose-dddddddddddddddddddd";
    const calls: string[] = [];
    const docker = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === `/containers/${name}/json`) {
          return {
            Id: "1",
            Name: name,
            State: { Running: true, Status: "running" },
            Config: { Labels: { "guild.sandbox.project": "compose" } },
          };
        }
        if (path === `/containers/${name}/exec`) return { Id: "exec-1" };
        if (path === "/exec/exec-1/json") return { Running: false, ExitCode: 1 };
        return {};
      },
    } as unknown as DockerClient;
    const manager = new SandboxManager(config, docker, log);
    await expect(manager.attach(name)).rejects.toThrow(/mount is dead/);
    expect(calls).toContain("POST /exec/exec-1/start");
    expect(calls).toContain(`DELETE /containers/${name}?force=true`);
  });
});

describe("ensure on a dead volume", () => {
  it("rejects with a retryable 503 and restarts the runner", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "guild-runner-volume-"));
    const boot = loadRunnerConfig(
      { ...env, GUILD_SANDBOX_DATA_DIR: root, GUILD_SANDBOX_AGENT_DIR: path.join(root, "agents") },
      { project: "compose" },
    );
    const docker = {
      request: async (_method: string, p: string) => {
        if (p.startsWith("/containers/") && p.endsWith("/json")) throw new DockerError(404, "no such container");
        return {};
      },
    } as unknown as DockerClient;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const manager = new SandboxManager(boot, docker, pino({ level: "silent" }));
    const error = await manager.ensure(`chat:${ORG}:dead`, `chats/${ORG}/deadmount`).catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(503);
    expect((error as Error).message).toMatch(/volume is stale/);
    // The exit is deferred 100ms so the 503 reaches the client first.
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    vi.useRealTimers();
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});

describe("wire codec", () => {
  it("round-trips bytes, undefined, and env errors", () => {
    const value = {
      bytes: new Uint8Array([0, 1, 255]),
      missing: undefined,
      list: [undefined, 1],
      fileError: new FileError("not_found", "nope", "/x"),
      execError: Object.assign(new ExecutionError("timeout", "slow"), { spillPath: "/tmp/s" }),
    };
    const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(decoded.bytes).toEqual(new Uint8Array([0, 1, 255]));
    expect("missing" in decoded && decoded.missing).toBe(undefined);
    expect(decoded.list).toEqual([undefined, 1]);
    expect(decoded.fileError).toBeInstanceOf(FileError);
    expect(decoded.fileError.code).toBe("not_found");
    expect(decoded.fileError.path).toBe("/x");
    expect(decoded.execError).toBeInstanceOf(ExecutionError);
    expect(decoded.execError.spillPath).toBe("/tmp/s");
  });

  it("keeps U+0000 in a call argument, so a binary write is lossless", () => {
    const value = { path: "/tmp/x", content: "PK\u0000tail", "a\u0000b": 1 };
    const decoded = decodeValue(JSON.parse(JSON.stringify(encodeValue(value)))) as typeof value;
    expect(decoded.content).toBe("PK\u0000tail");
    expect(decoded["a\u0000b"]).toBe(1);
  });

  it("splits frames across chunk boundaries and multibyte characters", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter();
    const bytes = Buffer.from('{"a":"é"}\n{"b":1}\n{"c"');
    splitter.push(bytes.subarray(0, 8), (l) => lines.push(l)); // splits é
    splitter.push(bytes.subarray(8), (l) => lines.push(l));
    splitter.push(Buffer.from(":2}\n"), (l) => lines.push(l));
    expect(lines).toEqual(['{"a":"é"}', '{"b":1}', '{"c":2}']);
  });
});
