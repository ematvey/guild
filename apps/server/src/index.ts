// Placeholder entrypoint — replaced by the M0 shell milestone.
// Keeps the scaffold buildable/typecheckable before the Fastify app lands.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);
createServer((_req, res) => {
  res.writeHead(503, { "content-type": "text/plain" });
  res.end("guild TS server: scaffold only\n");
}).listen(port, "0.0.0.0");
