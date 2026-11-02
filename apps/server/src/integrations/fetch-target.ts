// The SSRF guard for model-chosen fetch targets (web_fetch, map): the URL
// must be http(s) and its host must not be, or resolve to, a private,
// loopback, link-local, CGNAT, multicast or cloud-metadata address. The
// fetch itself runs in the scraping service, which sits inside the
// deployment's network, so a target the guard lets through must be one any
// public client could reach.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isNonPublicAddress } from "./ip-guard.js";

/** Host names that always mean this machine or the cloud metadata service. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

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
