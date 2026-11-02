// Agents test harness: the shared disposable database/app. An unreachable
// Postgres fails the suite like every other database suite; with
// GUILD_TEST_SKIP_DB=1 it skips instead. Only connection-level error codes
// count as unreachable; a migration or query failure always fails.

import type { HubTestEnv } from "../support/hub-env.js";

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

/** Returns the shared test env, or null when Postgres is unreachable and
 *  GUILD_TEST_SKIP_DB=1 asks for a skip. */
export async function createAgentsTestEnv(): Promise<HubTestEnv | null> {
  try {
    const { createHubTestEnv } = await import("../support/hub-env.js");
    return await createHubTestEnv("silent");
  } catch (error) {
    if (isUnavailable(error) && process.env.GUILD_TEST_SKIP_DB === "1") {
      console.warn(`agents tests skipped: ${(error as Error).message}`);
      return null;
    }
    throw error;
  }
}
