import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { RunnerClient } from "./src/sandbox/client.ts";

const { SANDBOX_KEY: key, SANDBOX_SUBPATH: subpath, PROBE_PHASE: phase, PROBE_VALUE: marker } = process.env;
assert.ok(key && subpath && phase && marker);
const runner = new RunnerClient(process.env.GUILD_SANDBOX_RUNNER_URL, process.env.GUILD_SANDBOX_RUNNER_TOKEN);
const markerFile = "runner-probe.txt";
if (phase === "cleanup") {
  const root = process.env.GUILD_AGENT_WORKSPACE_ROOT;
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  assert.ok(root && new RegExp(`^agents/00000000-0000-4000-8000-000000000001/${uuid}$`).test(subpath));
  assert.equal(key, subpath.replace(/^agents\//, "agent:").replace("/", ":"));
  try {
    await runner.remove(key);
  } finally {
    await rm(join(root, subpath, markerFile), { force: true });
  }
} else {
  assert.ok(phase === "write" || phase === "read");
  assert.equal((await runner.health()).runtime, "substrate");
  const name = await runner.ensure({ key, subpath });
  const wire = await runner.connect(name);
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("sandbox RPC timed out")), 5000);
      wire.onClose((error) => {
        clearTimeout(timeout);
        reject(error ?? new Error("sandbox RPC disconnected"));
      });
      wire.onFrame((raw) => {
        clearTimeout(timeout);
        resolve(JSON.parse(raw));
      });
      const [method, args] = phase === "write" ? ["writeFile", [markerFile, marker]] : ["readTextFile", [markerFile]];
      wire.send(JSON.stringify({ t: "call", id: 1, m: method, a: args }));
    });
    assert.equal(result.t, "result", JSON.stringify(result));
    assert.equal(result.r.ok, true, JSON.stringify(result));
    if (phase === "read") assert.equal(result.r.value, marker);
    process.stdout.write(`${name}\n`);
  } finally {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sandbox close timed out")), 8000);
      wire.onClose(() => { clearTimeout(timer); resolve(); });
      wire.close();
    });
  }
}
