// The save-gate probe every plugin's testConnection uses: any 2xx passes, a
// transport failure or a non-2xx status fails with the connector's text.

const PROBE_TIMEOUT_MS = 15_000;

export async function probe(req: Promise<Response>, what: string): Promise<void> {
  let res: Response;
  try {
    res = await req;
  } catch (error) {
    const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new Error(`${what} unreachable: ${cause}`);
  }
  if (!res.ok) {
    throw new Error(`${what} rejected the connection (${res.status} ${res.statusText})`);
  }
}

export function fetchTimeout(init?: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
}
