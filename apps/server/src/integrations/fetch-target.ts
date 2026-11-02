// The SSRF guard for model-chosen fetch targets (web_fetch, map): the URL
// must be http(s) and its host must not be, or resolve to, a private,
// loopback, link-local, CGNAT, multicast or cloud-metadata address. The
// fetch itself runs in the scraping service, which sits inside the
// deployment's network, so a target the guard lets through must be one any
// public client could reach.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateIpLiteral } from "./mcp-url.js";

/** Host names that always mean this machine or the cloud metadata service. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

/** Address ranges beyond the private/loopback/link-local set that a public
 *  fetch never needs: this-network, CGNAT, benchmarking, multicast and
 *  reserved IPv4, and IPv6 multicast. */
function isNonPublicAddress(address: string): boolean {
  const h = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // The URL parser writes an IPv4-mapped address in hex (`::ffff:7f00:1`):
  // back to dotted form, so the IPv4 rules apply to it.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hexMapped !== null) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isNonPublicAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (isPrivateIpLiteral(h)) return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  const v4text = mapped !== null ? mapped[1]! : h;
  if (isIP(v4text) === 4) {
    const [a, b] = v4text.split(".").map(Number) as [number, number];
    return a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(h) === 6) return /^ff/i.test(h);
  return false;
}

/** Refuses a fetch target that is not a public http(s) URL. Resolves the
 *  host and checks every address it maps to. Returns the parsed URL. */
export async function assertPublicFetchTarget(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must be http(s)");
  const host = url.hostname.toLowerCase();
  if (host === "") throw new Error("url must carry a host");
  const refused = (): Error => new Error("private, loopback and metadata addresses are not allowed");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) throw refused();
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) {
    if (isNonPublicAddress(bare)) throw refused();
    return url;
  }
  // RFC 2606 reserved names never resolve anywhere, so they reach nothing.
  if (/\.(test|example|invalid)$/.test(host)) return url;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("url host does not resolve");
  }
  if (addresses.some((entry) => isNonPublicAddress(entry.address))) throw refused();
  return url;
}
