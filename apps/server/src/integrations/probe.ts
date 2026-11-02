// The save-gate probe every plugin's testConnection uses: any 2xx passes, a
// transport failure or a non-2xx status fails with the connector's text.
// Probe requests take their timeout from `fetchTimeout(PROBE_TIMEOUT_MS, …)`.

import { transportCause } from "./shared.js";

export const PROBE_TIMEOUT_MS = 15_000;

export async function probe(req: Promise<Response>, what: string): Promise<void> {
  let res: Response;
  try {
    res = await req;
  } catch (error) {
    throw new Error(`${what} unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) {
    throw new Error(`${what} rejected the connection (${res.status} ${res.statusText})`);
  }
}
