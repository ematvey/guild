import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Forks (a fresh process per suite file) instead of threads: the suites
    // share no event loop, undici connection pool, or timers — a stalled or
    // leaking suite cannot poison the next one.
    pool: "forks",
    // Only the TypeScript sources; compiled copies under dist/ are never
    // runnable (their data files are not emitted).
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Each suite worker holds several Postgres connections (app pool,
    // seeding pools, the notify client) on the shared dev server, whose
    // 100-connection budget also serves temporal/agenta/posthog — under
    // load even 6 workers exhaust the remaining slots (observed 2026-10-04:
    // 81/100 held by other tenants). Sequential file execution is the
    // stable mode; single suites are fast enough.
    fileParallelism: false,
  },
});
