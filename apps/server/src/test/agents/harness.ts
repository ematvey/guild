// Agents test harness: the shared M5 disposable database/app, plus a
// clean skip when the local Postgres is unreachable.

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
  const code = (error as { code?: string }).code;
  if (code !== undefined && UNAVAILABLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("connect") ||
    message.includes("does not exist") ||
    message.includes("is not set")
  );
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
