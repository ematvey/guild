import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript sources; compiled copies under dist/ are never
    // runnable (their data files are not emitted).
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Each suite worker holds several Postgres connections (app pool,
    // seeding pools, the notify client) on the shared dev server, whose
    // 100-connection budget also serves temporal/agenta/posthog — the
    // default parallelism exhausts the remaining slots under load.
    maxWorkers: 6,
  },
});
