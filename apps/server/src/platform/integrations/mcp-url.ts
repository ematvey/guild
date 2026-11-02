// The SSRF guard for user-owned MCP servers: a URL must be http(s) and its
// host must not be, or resolve to, a private, loopback or link-local
// address. The settings routes check it on save and the runtime on every
// connect, so a name later re-pointed at a private service is refused too.

import { lookup } from "node:dns/promises";
import { ApiError } from "../errors.js";

/** Whether the host string is a private/loopback/link-local IP literal
 *  (IPv4 dotted quad + the ranges below, or IPv6 in brackets or bare). */
export function isPrivateIpLiteral(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) delegates to the IPv4 rules.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mapped !== null) return isPrivateIpLiteral(mapped[1]!);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if ([a, b, c, Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    return false;
  }
  if (h === "::1" || h === "::") return true;
  if (h.includes(":")) {
    // fe80::/10 and fc00::/7: the first hextet decides.
    const first = h.split(":")[0] ?? "";
    const n = parseInt(first, 16);
    if (!Number.isNaN(n) && ((n >= 0xfe80 && n <= 0xfebf) || (n >= 0xfc00 && n <= 0xfdff))) return true;
  }
  return false;
}

/** Hostnames allowed to resolve to a private address. The compose deployment
 *  reaches `host.docker.internal`; anything else must resolve public. */
function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env.GUILD_MCP_ALLOWED_HOSTS ?? "host.docker.internal")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

/** URL validation: http(s), a host, and the SSRF guard. The guard checks IP
 *  literals and every address the hostname resolves to, so a name that
 *  points at a private service is refused like the literal would be. */
export async function validateUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ApiError.badRequest("url must be http(s)");
  }
  if (url.hostname === "") throw ApiError.badRequest("url must carry a host");
  if (process.env.GUILD_MCP_ALLOW_PRIVATE === "1") return;
  if (isPrivateIpLiteral(url.hostname)) {
    throw ApiError.badRequest("private and loopback addresses are not allowed");
  }
  if (allowedPrivateHosts().has(url.hostname.toLowerCase())) return;
  // RFC 2606 reserved names never resolve, so they cannot reach a private
  // service. Tests use them as stand-ins for a real remote host.
  if (/\.(test|example|invalid)$/i.test(url.hostname)) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw ApiError.badRequest("url host does not resolve");
  }
  if (addresses.some((a) => isPrivateIpLiteral(a.address))) {
    throw ApiError.badRequest("private and loopback addresses are not allowed");
  }
}
