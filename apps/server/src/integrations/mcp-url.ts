// The SSRF guard for user-owned MCP servers: a URL must be http(s) and its
// host must not be, or resolve to, a private, loopback or link-local
// address. The settings routes check it on save and the runtime on every
// connect, so a name later re-pointed at a private service is refused too.

import { lookup } from "node:dns/promises";
import { ApiError } from "../platform/errors.js";
import { isNonPublicAddress } from "./ip-guard.js";

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
  if (isNonPublicAddress(url.hostname)) {
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
  if (addresses.some((a) => isNonPublicAddress(a.address))) {
    throw ApiError.badRequest("private and loopback addresses are not allowed");
  }
}
