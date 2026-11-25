import { createServer } from "node:http";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { WebSocket, WebSocketServer } from "ws";
import { serveEnv } from "./serve.js";

const server = createServer((request, response) => {
  response.writeHead(request.method === "GET" && request.url === "/readyz" ? 200 : 404).end();
});
const sockets = new WebSocketServer({
  server,
  path: "/rpc",
  maxPayload: 256 * 1024 * 1024,
  perMessageDeflate: false,
});

sockets.on("connection", (socket) => {
  const env = new NodeExecutionEnv({ cwd: "/workspace" });
  void serveEnv(env, {
    send(frame) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    onFrame(listener) {
      socket.on("message", (data, binary) => {
        if (binary) {
          socket.close(1003, "expected a text frame");
          return;
        }
        listener(data.toString());
      });
    },
    onClose(listener) {
      socket.once("close", () => listener());
    },
    close() {
      socket.close();
    },
  });
  socket.on("error", () => socket.terminate());
});

server.listen(8080, "0.0.0.0");
