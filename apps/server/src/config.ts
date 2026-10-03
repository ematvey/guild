// Env-driven configuration, same style as the Rust server's config.env
// (deploy/compose/config.env.example). M0 shell only needs the bind address,
// the Rust upstream to proxy to, and the log level.

export interface Config {
  /** Address the Fastify server binds, e.g. 0.0.0.0:8080 (GUILD_BIND_ADDR). */
  bindHost: string;
  bindPort: number;
  /** Base URL of the Rust server every non-native route proxies to
   *  (GUILD_UPSTREAM_URL, e.g. http://server-rust:8080). */
  upstreamUrl: string;
  /** pino log level (GUILD_LOG_LEVEL). */
  logLevel: string;
}

export const DEFAULT_BIND_ADDR = "0.0.0.0:8080";
export const DEFAULT_UPSTREAM_URL = "http://server-rust:8080";
export const DEFAULT_LOG_LEVEL = "info";

function parseBindAddr(addr: string): { host: string; port: number } {
  // Split at the last colon: works for 0.0.0.0:8080 and [::]:8080.
  const idx = addr.lastIndexOf(":");
  if (idx === -1) throw new Error(`GUILD_BIND_ADDR: missing port in "${addr}"`);
  const host = addr.slice(0, idx);
  const portStr = addr.slice(idx + 1);
  const port = Number(portStr);
  if (!host) throw new Error(`GUILD_BIND_ADDR: missing host in "${addr}"`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GUILD_BIND_ADDR: invalid port "${portStr}"`);
  }
  return { host, port };
}

function parseUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GUILD_UPSTREAM_URL: not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`GUILD_UPSTREAM_URL: must be http(s), got "${url.protocol}"`);
  }
  // Normalize: no trailing slash, no path suffix — the proxy forwards the
  // full request path onto the upstream origin.
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = parseBindAddr(env.GUILD_BIND_ADDR ?? DEFAULT_BIND_ADDR);
  const upstreamUrl = parseUpstreamUrl(env.GUILD_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL);
  const logLevel = env.GUILD_LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    upstreamUrl,
    logLevel,
  };
}
