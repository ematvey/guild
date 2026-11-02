// Agents test harness: the shared disposable database/app, plus a clean
// skip when the local Postgres cannot be reached. Only connection-level
// error codes skip; a migration or query failure fails the suite.

import type { M5TestEnv } from "../platform/m5-harness.js";

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "28P01",
  "3D000",
  "57P03",
]);

function isUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  // Node reports a refused dual-stack connect as an AggregateError whose
  // members carry the codes.
  if (error instanceof AggregateError) return error.errors.some(isUnavailable);
  return false;
}

/** Returns the shared test env, or null when Postgres is not available. */
export async function createAgentsTestEnv(): Promise<M5TestEnv | null> {
  try {
    const { createM5TestEnv } = await import("../platform/m5-harness.js");
    return await createM5TestEnv("silent");
  } catch (error) {
    if (isUnavailable(error)) {
      console.warn(`agents tests skipped: ${(error as Error).message}`);
      return null;
    }
    throw error;
  }
}
