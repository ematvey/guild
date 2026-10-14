// guild-sandbox-agent: the process the runner execs inside a sandbox
// container per RPC connection. Serves a NodeExecutionEnv rooted at the
// workspace over stdin/stdout (one JSON frame per line); stderr is for
// diagnostics only. Exits when stdin ends.

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LineSplitter, type Wire } from "./protocol.js";
import { serveEnv } from "./serve.js";

function stdioWire(): Wire {
  const splitter = new LineSplitter();
  const closeListeners: Array<(error?: Error) => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const l of closeListeners) l();
  };
  process.stdin.on("end", close);
  process.stdin.on("error", close);
  process.stdout.on("error", close);
  return {
    send(frame) {
      if (!closed) process.stdout.write(`${frame}\n`);
    },
    onFrame(listener) {
      process.stdin.on("data", (chunk: Buffer) => splitter.push(chunk, listener));
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    close,
  };
}

const cwd = process.env.GUILD_SANDBOX_CWD ?? "/workspace";
const env = new NodeExecutionEnv({ cwd });
await serveEnv(env, stdioWire());
process.exit(0);
