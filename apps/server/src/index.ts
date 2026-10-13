// Entry point: load config, start Fastify, shut down gracefully on
// SIGTERM/SIGINT (docker stop sends SIGTERM).

import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().catch((err) => {
        app.log.error(err, "error during shutdown");
        process.exit(1);
      });
    });
  }

  await app.listen({ host: config.bindHost, port: config.bindPort });
}

main().catch((err) => {
  // Logger may not exist yet (config errors) — fall back to stderr.
  console.error(err);
  process.exit(1);
});
