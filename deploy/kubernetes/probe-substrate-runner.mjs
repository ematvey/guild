import assert from "node:assert/strict";
import { RunnerClient } from "./src/sandbox/client.ts";

const { SANDBOX_KEY: key, SANDBOX_SUBPATH: subpath, PROBE_PHASE: phase, PROBE_VALUE: marker } = process.env;
assert.ok(key && subpath && phase && marker);
const runner = new RunnerClient(process.env.GUILD_SANDBOX_RUNNER_URL, process.env.GUILD_SANDBOX_RUNNER_TOKEN);
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
    const path = "runner-probe.txt";
    const [method, args] = phase === "write" ? ["writeFile", [path, marker]] : ["readTextFile", [path]];
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
