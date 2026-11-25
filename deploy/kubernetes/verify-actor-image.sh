#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: verify-actor-image.sh IMAGE}"
container="$(docker run --rm --detach --network none --tmpfs /workspace:uid=1000,gid=1000 "$image" node /opt/guild/actor.js)"
trap 'docker stop "$container" >/dev/null' EXIT

docker exec -i "$container" node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

async function connect() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const socket = new WebSocket("ws://127.0.0.1:8080/rpc");
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(1000) });
      return socket;
    } catch (err) {
      socket.close();
      if (attempt === 24) throw err;
      await delay(200);
    }
  }
}

async function call(socket, id, method, args) {
  const reply = new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(5000);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    socket.addEventListener("message", (event) => {
      const result = JSON.parse(event.data);
      if (result.id === id && (result.t === "result" || result.t === "throw")) resolve(result);
    }, { signal });
  });
  socket.send(JSON.stringify({ t: "call", id, m: method, a: args }));
  const result = await reply;
  assert.equal(result.t, "result", result.message);
  assert.equal(result.r.ok, true, JSON.stringify(result.r));
  return result.r.value;
}

const writer = await connect();
try {
  await call(writer, 1, "writeFile", ["probe.txt", "actor workspace"]);
} finally {
  writer.close();
}
const reader = await connect();
try {
  assert.equal(await call(reader, 1, "readTextFile", ["probe.txt"]), "actor workspace");
} finally {
  reader.close();
}
JS
