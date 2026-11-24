import assert from "node:assert/strict";
import { once } from "node:events";
import { connectActor } from "./actor-probe/router.ts";

const { ACTOR_NAME: actor, PROBE_PHASE: phase = "resolve", PROBE_VALUE: marker } = process.env;
assert.match(actor ?? "", /^[a-z0-9-]+$/);
assert.ok(["resolve", "write", "read", "absent"].includes(phase));
const signal = AbortSignal.timeout(30_000);
const socket = await connectActor({
  url: new URL("https://atenet-router.ate-system.svc:8444"),
  credentialPath: "/run/ate-router/credential.pem",
  trustPath: "/run/ate-router/trust.pem",
}, "guild-experiment", actor, signal);

async function call(method, args) {
  const response = once(socket, "message", { signal });
  socket.send(JSON.stringify({ t: "call", id: 1, m: method, a: args }));
  const [message] = await response;
  const frame = JSON.parse(message.toString());
  assert.equal(frame.t, "result", frame.message);
  assert.equal(frame.id, 1);
  assert.equal(frame.r.ok, true, JSON.stringify(frame.r));
  return frame.r.value;
}

try {
  assert.equal(await call("absolutePath", ["probe.txt"]), "/workspace/probe.txt");
  if (phase !== "resolve") {
    const path = process.env.PROBE_PATH ?? "/home/node/guild-substrate-probe.txt";
    if (phase === "absent") {
      assert.equal(await call("exists", [path]), false);
    } else {
      assert.ok(marker);
      if (phase === "write") await call("writeFile", [path, marker]);
      else assert.equal(await call("readTextFile", [path]), marker);
    }
  }
  process.stdout.write(`${actor}: ${phase} passed\n`);
} finally {
  socket.close();
}
