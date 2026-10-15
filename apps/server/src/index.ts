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
      // Hard exit, no graceful close: pi-durable's close signals the
      // in-flight generations, and the runner converts that abort into a
      // failed terminal outcome through its retry path — a deploy would
      // still end every running turn. A hard stop leaves the journal
      // consistent (commits are atomic) and the runs pending, so the next
      // process's harness.resume() re-drives them: the turn continues
      // where it stopped instead of ending as interrupted.
      process.exit(0);
    });
  }

  await app.listen({ host: config.bindHost, port: config.bindPort });
}

main().catch((err) => {
  // Logger may not exist yet (config errors) — fall back to stderr.
  console.error(err);
  process.exit(1);
});
