// The runner's container policy (no Docker): what a request can and cannot
// influence, and the config the runner refuses to start with.

import { describe, expect, it } from "vitest";
import { containerName, containerSpec, loadRunnerConfig, validKey, validSubpath } from "../../sandbox/runner/spec.js";
import { decodeValue, encodeValue, LineSplitter } from "../../sandbox/protocol.js";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";

const ORG = "0194a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const env = {
  GUILD_SANDBOX_RUNNER_TOKEN: "x".repeat(32),
  GUILD_SANDBOX_PROXY_URL: "http://10.213.0.2:3128",
};

describe("subpath and key validation", () => {
  it("accepts only workspaces/<org>/<name> and chats/<org>/<id>", () => {
    expect(validSubpath(`workspaces/${ORG}/repo-1`)).toBe(true);
    expect(validSubpath(`chats/${ORG}/42`)).toBe(true);
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
    ]) {
      expect(validSubpath(bad), bad).toBe(false);
    }
    expect(validKey(`ws:${ORG}:repo-1`)).toBe(true);
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
    const spec = containerSpec(none, `ws:${ORG}:r`, `workspaces/${ORG}/r`) as { Env: string[]; NetworkDisabled: boolean; HostConfig: Record<string, unknown> };
    expect(spec.NetworkDisabled).toBe(true);
    expect(spec.HostConfig["NetworkMode"]).toBe("none");
    expect(spec.Env.some((e) => /proxy/i.test(e))).toBe(false);
  });

  it("names containers per project and key", () => {
    expect(containerName({ project: "compose" }, "a")).toMatch(/^guild-sbx-compose-[0-9a-f]{20}$/);
    expect(containerName({ project: "compose" }, "a")).not.toBe(containerName({ project: "guild-live" }, "a"));
  });

  it("refuses to start without a token or with a proxy named by hostname", () => {
    expect(() => loadRunnerConfig({}, { project: null })).toThrow(/TOKEN/);
    expect(() => loadRunnerConfig({ ...env, GUILD_SANDBOX_PROXY_URL: "http://egress:3128" }, { project: null })).toThrow(/IP address/);
    expect(() => loadRunnerConfig({ GUILD_SANDBOX_RUNNER_TOKEN: "x".repeat(32) }, { project: null })).toThrow(/PROXY_URL/);
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
