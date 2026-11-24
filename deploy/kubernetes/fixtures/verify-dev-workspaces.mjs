import assert from "node:assert/strict";
import { RunnerClient } from "./src/sandbox/client.ts";
import { readFile } from "node:fs/promises";
const org = "00000000-0000-4000-8000-000000000001";
const id = crypto.randomUUID();
const database = new URL(process.env.GUILD_DATABASE_URL);
const workspace = process.env.GUILD_AGENT_WORKSPACE_ROOT;
const dataDir = process.env.GUILD_DATA_DIR;
assert.ok(workspace && dataDir);
const port = database.port || "5432";
const host = database.hostname;
const postgresSslRequest = [0, 0, 0, 8, 4, 210, 22, 47];
const { connect } = await import("node:net");
await new Promise((resolve, reject) => {
  const control = connect(Number(port), host, () => control.write(Buffer.from(postgresSslRequest)));
  control.setTimeout(2500, () => control.destroy(new Error("Guild PostgreSQL control timed out")));
  control.once("error", reject);
  control.once("end", () => reject(new Error("Guild PostgreSQL control ended without a response")));
  control.once("data", (data) => {
    control.destroy();
    if (data[0] === 0x53 || data[0] === 0x4e) resolve();
    else reject(new Error("Guild PostgreSQL control received an unexpected response"));
  });
});
const runner = new RunnerClient(process.env.GUILD_SANDBOX_RUNNER_URL, process.env.GUILD_SANDBOX_RUNNER_TOKEN);
assert.equal((await runner.health()).runtime, "substrate");
async function check(key, subpath, path) {
  const name = await runner.ensure({key,subpath});
  const wire = await runner.connect(name);
  const waiting = new Map();
  let output = "";
  wire.onFrame((raw) => {
    const frame = JSON.parse(raw);
    if (frame.t === "output") output += frame.text;
    if (frame.t === "result") waiting.get(frame.id)?.(frame.r);
  });
  wire.onClose((error) => {
    for (const done of waiting.values()) done({ok:false,error:String(error)});
  });
  async function call(id, method, args) {
    const result = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error(method + " timed out")), 12000);
      waiting.set(id, (result) => {clearTimeout(timer); waiting.delete(id); resolve(result);});
      wire.send(JSON.stringify({t:"call",id,m:method,a:args}));
    });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  }
  try {
    await call(1,"writeFile",["runner-probe.txt","guild-default-cluster"]);
    assert.equal(await readFile(path + "/runner-probe.txt","utf8"), "guild-default-cluster");
    const command = "const net = require('node:net'); const socket = net.connect(Number(process.argv[2]), process.argv[1]); socket.on('connect', () => socket.write(Buffer.from([0,0,0,8,4,210,22,47]))); socket.on('data', () => process.exit(42)); socket.on('end', blocked); socket.on('error', blocked); socket.setTimeout(2000, blocked); function blocked() { socket.destroy(); console.log('postgres-blocked'); }";
    const result = await call(2,"exec",[["node","-e",command,host,port],{onOutput:true}]);
    assert.ok(result.exitCode === 0 && output.includes("postgres-blocked"), JSON.stringify({result,output}));
    console.log(`Substrate verified ${name}, shared workspace write and blocked dev PostgreSQL`);
  } finally {
    wire.close();
  }
}
await check(`agent:${org}:${id}`, `agents/${org}/${id}`, `${workspace}/agents/${org}/${id}`);
const plain = Date.now();
await check(`chat:${org}:${plain}`, `chats/${org}/${plain}`, `${dataDir}/chats/${org}/${plain}`);
