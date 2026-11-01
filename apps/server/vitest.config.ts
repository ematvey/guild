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
    // seeding pools, the notify client) on the shared dev server, which also
    // serves temporal/posthog. It ran 300 connections before 2026-10-22 and
    // 500 since; fourteen workers hold at most ~140 of them, well inside the
    // budget. The files are independent stacks (own database, own ClickHouse
    // database, own temp roots), so running them side by side is safe.
    fileParallelism: true,
    maxWorkers: 14,
    minWorkers: 1,
    // A test or hook that builds its own stack (disposable database, every
    // migration, a built app) runs beside thirteen others on the shared
    // server; the 5 s / 10 s defaults measure that contention, not the code.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
