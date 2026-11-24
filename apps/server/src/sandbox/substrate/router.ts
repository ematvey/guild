import { readFile } from "node:fs/promises";
import { request } from "node:https";
import type { Duplex } from "node:stream";
import WebSocket from "ws";

export interface ActorRouter {
  url: URL;
  credentialPath: string;
  trustPath: string;
}

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Opens a WebSocket to the sandbox agent through the router's mTLS CONNECT listener. */
export async function connectActor(
  router: ActorRouter,
  atespace: string,
  actor: string,
  signal: AbortSignal,
  endpoint: { path: "/rpc" | "/control"; headers?: Record<string, string>; maxPayload?: number } = { path: "/rpc" },
): Promise<WebSocket> {
  if (!label.test(atespace) || !label.test(actor)) throw new Error("invalid Actor identity");
  if (router.url.protocol !== "https:") throw new Error("Actor router requires HTTPS");
  const [credential, ca] = await Promise.all([readFile(router.credentialPath), readFile(router.trustPath)]);
  const authority = `${actor}:8080`;
  const tunnel = await new Promise<Duplex>((resolve, reject) => {
    const connect = request(router.url, {
      method: "CONNECT",
      servername: router.url.hostname,
      path: authority,
      headers: { host: authority, "ate-target-actor": `${atespace}/${actor}` },
      cert: credential,
      key: credential,
      ca,
      agent: false,
      signal,
    });
    connect.once("error", reject);
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Actor router CONNECT returned ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    connect.end();
  });
  try {
    signal.throwIfAborted();
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://${authority}${endpoint.path}`, {
        createConnection: () => tunnel,
        maxPayload: endpoint.maxPayload ?? 256 * 1024 * 1024,
        headers: endpoint.headers,
        signal,
      });
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        socket.terminate();
        reject(new Error(`Actor WebSocket upgrade returned ${response.statusCode}`));
      });
      socket.once("open", () => {
        socket.off("error", reject);
        resolve(socket);
      });
    });
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
}
