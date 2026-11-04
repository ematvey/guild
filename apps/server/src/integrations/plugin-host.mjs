// The worker a registry code plugin runs in. It imports one plugin.js (the
// bundle's entry, written to disk by code-plugins.ts) and answers the
// server's calls over the worker port: `manifest`, `validate`,
// `testConnection`, and `execute`. One call is one message pair, matched by
// id; a plugin error comes back as its message text.

import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(workerData.entry).href);
const plugin = mod.default;

function check() {
  if (plugin === null || typeof plugin !== "object" || typeof plugin.manifest !== "object") {
    throw new Error("plugin.js has no default plugin export");
  }
  if (typeof plugin.execute !== "function" || typeof plugin.testConnection !== "function") {
    throw new Error("the plugin export lacks execute or testConnection");
  }
}

async function run(op, args) {
  check();
  switch (op) {
    case "manifest":
      return plugin.manifest;
    case "validate":
      if (typeof plugin.validate === "function") plugin.validate(args.config);
      return null;
    case "testConnection":
      await plugin.testConnection(args.config, args.secrets);
      return null;
    case "execute":
      return await plugin.execute(args.config, args.tool, args.args, args.secrets, args.actingAs);
    default:
      throw new Error(`unknown plugin host op ${op}`);
  }
}

parentPort.on("message", async (message) => {
  const { id, op, args } = message;
  try {
    const value = await run(op, args);
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    parentPort.postMessage({ id, ok: false, error: text });
  }
});
