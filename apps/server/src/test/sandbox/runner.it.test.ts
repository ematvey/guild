// Sandbox integration suite: a real runner, gVisor sandboxes and the egress
// proxy (scripts/sandbox-it.sh starts them). Skipped unless
// GUILD_SANDBOX_IT_URL is set.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { RunnerClient, type SandboxTarget } from "../../sandbox/client.js";
import { SandboxExecutionEnv } from "../../sandbox/env.js";
import { waitFor } from "../support/wait.js";

const URL_ = process.env.GUILD_SANDBOX_IT_URL;
const TOKEN = process.env.GUILD_SANDBOX_RUNNER_TOKEN ?? "";
const substrate = process.env.GUILD_SANDBOX_IT_RUNTIME === "substrate";
const ctx = BACKGROUND_CONTEXT;
const ORG = randomUUID();
const runner = new RunnerClient(URL_ ?? "http://unused", TOKEN);
const envs: SandboxExecutionEnv[] = [];

function target(name: string): SandboxTarget {
  return { key: `ws:${ORG}:${name}`, subpath: `workspaces/${ORG}/${name}` };
}

function envFor(t: SandboxTarget, cwd = "/workspace"): SandboxExecutionEnv {
  const env = new SandboxExecutionEnv({
    id: `sandbox:${t.key}`,
    cwd,
    connect: async () => runner.connect(await runner.ensure(t)),
  });
  envs.push(env);
  return env;
}

async function sh(
  env: SandboxExecutionEnv,
  command: string,
  timeout = 120_000,
): Promise<{ code: number; out: string }> {
  let out = "";
  const result = await env.exec(command, { timeout, onOutput: (text) => (out += text) }, ctx);
  if (!result.ok) throw result.error;
  return { code: result.value.exitCode, out };
}

describe.skipIf(URL_ === undefined)("sandbox runner (integration)", () => {
  const main = target("main");
  let env: SandboxExecutionEnv;

  beforeAll(async () => {
    env = envFor(main);
  }, 120_000);

  afterAll(async () => {
    for (const e of envs) e.disconnect();
  });

  describe("confinement", () => {
    it("runs under gVisor as the sandbox uid", async () => {
      const { out } = await sh(env, "uname -r; id -u; id -g");
      expect(out).toMatch(/gvisor/);
      expect(out.split("\n").slice(1, 3)).toEqual(["1000", "1000"]);
    });

    it("sees no runner or server environment", async () => {
      const { out } = await sh(env, "cat /proc/self/environ | tr '\\0' '\\n'; cat /proc/1/environ | tr '\\0' '\\n'");
      expect(out).not.toMatch(/GUILD_SANDBOX_RUNNER_TOKEN|GUILD_MASTER_KEY|GUILD_DATABASE_URL|GUILD_JWT/);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain(substrate ? "HOME=/home/node\n" : "HOME=/home/sandbox\n");
    });

    it("cannot see the data volume, the docker socket, or other workspaces", async () => {
      const other = envFor(target("other"));
      await sh(other, "echo top-secret > secret.txt");
      other.disconnect();
      const { out } = await sh(
        env,
        "ls /data 2>&1; ls -la /var/run/docker.sock 2>&1; ls /workspace; cat /workspace/secret.txt 2>&1; mount | grep -c workspace",
      );
      expect(out).toMatch(/ls: cannot access '\/data'/);
      expect(out).toMatch(/docker\.sock': No such file/);
      expect(out).not.toContain("top-secret");
      // The file tools: absolute paths reach only the sandbox's own fs.
      const read = await env.readTextFile("/proc/self/environ", ctx);
      expect(read.ok && read.value.includes("GUILD_SANDBOX_RUNNER_TOKEN")).toBe(false);
      const outside = await env.readTextFile("/data/workspaces", ctx);
      expect(outside.ok).toBe(false);
    });

    it("shares an Agent Workspace while keeping Member and background scratch separate", async () => {
      const agentId = randomUUID();
      const key = `agent:${ORG}:${agentId}`;
      const subpath = `agents/${ORG}/${agentId}`;
      const targets = [
        { key: `${key}:member:${randomUUID()}`, subpath },
        { key: `${key}:member:${randomUUID()}`, subpath },
        { key: `${key}:background`, subpath },
      ];
      const [first, second, background] = targets.map((target) => envFor(target));
      try {
        const shared = await first!.writeFile("/workspace/shared.txt", "shared", ctx);
        if (!shared.ok) throw shared.error;
        expect((await first!.writeFile("/tmp/run.txt", "first", ctx)).ok).toBe(true);
        expect((await second!.writeFile("/tmp/run.txt", "second", ctx)).ok).toBe(true);
        expect((await background!.writeFile("/tmp/run.txt", "background", ctx)).ok).toBe(true);
        for (const [environment, expected] of [
          [first!, "first"],
          [second!, "second"],
          [background!, "background"],
        ] as const) {
          expect(await environment.readTextFile("/workspace/shared.txt", ctx)).toMatchObject({
            ok: true,
            value: "shared",
          });
          expect(await environment.readTextFile("/tmp/run.txt", ctx)).toMatchObject({ ok: true, value: expected });
        }
      } finally {
        first!.disconnect();
        second!.disconnect();
        background!.disconnect();
        await Promise.all(targets.map((target) => runner.remove(target.key)));
      }
    }, 120_000);

    it("has a read-only root filesystem and a writable workspace", async () => {
      const { out } = await sh(
        env,
        "touch /etc/x 2>&1; touch /usr/local/x 2>&1; touch /workspace/ok && echo WROTE; touch /tmp/t && echo TMP",
      );
      expect(out).toMatch(/Read-only file system|Permission denied/);
      expect(out).toContain("WROTE");
      expect(out).toContain("TMP");
      const write = await env.writeFile("/etc/passwd", "x", ctx);
      expect(write.ok).toBe(false);
    });
  });

  describe("network", () => {
    it("has no direct route out", async () => {
      const hostname = substrate ? "example.com" : "registry.npmjs.org";
      const { code, out } = await sh(
        env,
        `curl -sS --noproxy '*' --max-time 10 https://${hostname}/ -o /dev/null 2>&1`,
      );
      expect(code).not.toBe(0);
      expect(out).toMatch(/resolve|connect|unreachable/i);
    });

    it("reaches allowlisted registries through the runtime egress policy", async () => {
      const allowed = await sh(
        env,
        "curl -s --max-time 30 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/left-pad",
      );
      expect(allowed.out).toBe("200");
      const denied = await sh(env, "curl -s --max-time 30 -o /dev/null -w '%{http_code}' https://example.com/; echo");
      expect(denied.out.trim()).toMatch(/^(403|000)$/);
    });

    it("refuses private and host addresses through the runtime egress policy", async () => {
      // In an Actor, 127.0.0.1 reaches the Actor's own RPC listener.
      const loopback = substrate ? "" : "http://127.0.0.1:8080/";
      const { out } = await sh(
        env,
        `for u in http://172.17.0.1:5432/ http://10.0.0.1/ ${loopback} http://169.254.169.254/latest/meta-data/; do curl -s --max-time 15 -o /dev/null -w '%{http_code} ' $u; done`,
      );
      for (const code of out.trim().split(/\s+/)) expect(code).toMatch(/^(403|000)$/);
    });
  });

  describe("package installs", () => {
    it("installs npm and pip packages, globally and locally", async () => {
      const npm = await sh(
        env,
        "mkdir -p proj && cd proj && npm init -y >/dev/null && npm install --silent left-pad@1.3.0 && node -e \"console.log(require('left-pad')('x', 3))\"",
        300_000,
      );
      expect(npm.code, npm.out).toBe(0);
      expect(npm.out).toContain("  x");
      const global = await sh(env, "npm install -g --silent cowsay@1.6.0 && cowsay hi | head -2", 300_000);
      expect(global.code, global.out).toBe(0);
      const pip = await sh(
        env,
        "pip install --user --quiet six==1.16.0 && python3 -c 'import six; print(six.__version__)'",
        300_000,
      );
      expect(pip.code, pip.out).toBe(0);
      expect(pip.out).toContain("1.16.0");
    }, 600_000);

    it("keeps workspace files and project installs, drops the home, across sandbox removal", async () => {
      await sh(env, "echo persisted > keep.txt");
      env.disconnect();
      await runner.remove(main.key);
      const fresh = envFor(main);
      const { code, out } = await sh(
        fresh,
        "cat keep.txt; ls proj/node_modules; command -v cowsay; python3 -c 'import six' 2>&1 | tail -1",
      );
      expect(code, out).toBe(0);
      expect(out).toContain("persisted");
      expect(out).toContain("left-pad");
      // The home is a tmpfs: a user-level install does not outlive the container.
      expect(out).not.toContain("cowsay");
      expect(out).toMatch(/No module named '?six'?/);
      env = fresh;
    }, 300_000);
  });

  describe("runner API", () => {
    const post = (body: unknown, token = TOKEN) =>
      fetch(`${URL_}/v1/sandboxes`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("rejects missing or wrong tokens", async () => {
      expect((await post({ key: "ws:a:b", subpath: `workspaces/${ORG}/x` }, "wrong")).status).toBe(401);
      expect((await fetch(`${URL_}/v1/healthz`)).status).toBe(401);
    });

    it("rejects subpaths and keys outside the contract", async () => {
      for (const subpath of [
        "../etc",
        `workspaces/${ORG}/../../x`,
        "/etc",
        `workspaces/${ORG}/a/b`,
        `other/${ORG}/x`,
        `workspaces/${ORG}/..`,
      ]) {
        expect((await post({ key: "ws:x:y", subpath })).status, subpath).toBe(400);
      }
      expect((await post({ key: "bad key!", subpath: `workspaces/${ORG}/x` })).status).toBe(400);
    });

    it("refuses to attach to containers it does not own", async () => {
      await expect(runner.connect("compose-server-1")).rejects.toThrow(/400|401/);
      const absent = substrate
        ? `guild-${randomUUID().replaceAll("-", "")}`
        : "guild-sbx-someoneelse-0123456789abcdef0123";
      await expect(runner.connect(absent)).rejects.toThrow(/404/);
    });

    it("is idempotent and restarts stopped sandboxes on attach", async () => {
      const t = target("lifecycle");
      const a = await runner.ensure(t);
      const b = await runner.ensure(t);
      expect(a).toBe(b);
      const e = new SandboxExecutionEnv({ id: "x", cwd: "/workspace", connect: () => runner.connect(a) });
      envs.push(e);
      expect((await sh(e, "echo persisted > stop-test.txt")).code).toBe(0);
      e.disconnect();
      await waitFor(async () => {
        const stopped = await fetch(`${URL_}/v1/sandboxes/${a}/stop`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
        if (stopped.status === 409 && substrate) return false;
        expect(stopped.ok).toBe(true);
        return true;
      }, 5_000, 100, "sandbox connection did not close before stop");
      expect((await sh(e, "cat stop-test.txt")).out.trim()).toBe("persisted");
      const { out } = await sh(e, "echo alive");
      expect(out.trim()).toBe("alive");
    }, 120_000);

    it("drops in-flight calls when the connection is cut", async () => {
      const e = envFor(target("cut"));
      await sh(e, "true");
      // Cut once the command is running in the sandbox (its first output).
      let cut = false;
      const pending = e.exec(
        "echo started; sleep 30",
        {
          timeout: 60_000,
          onOutput: () => {
            if (cut) return;
            cut = true;
            e.disconnect();
          },
        },
        ctx,
      );
      const result = await pending;
      assert.ok(!result.ok);
      expect(result.error.message).toMatch(/connection lost/);
    }, 60_000);
  });

  describe("ExecutionEnv conformance in a real sandbox", () => {
    const conf = target("conformance");
    let n = 0;
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
        greaterThan: (actual, expected) => assert.ok(actual > expected),
        rejects: async (operation, messageIncludes) => {
          await assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes));
        },
      },
      withEnv: async (use) => {
        const dir = `/workspace/case-${++n}`;
        const e = envFor(conf, dir);
        const made = await e.createDir(dir, { recursive: true }, ctx);
        assert.ok(made.ok);
        try {
          await use(e);
        } finally {
          e.disconnect();
        }
      },
    });
    for (const c of cases) {
      it(c.name, { timeout: (c.timeoutMs ?? 20_000) + 30_000 }, () => c.run());
    }
  });
});
