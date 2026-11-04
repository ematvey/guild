// The one address classifier the outbound-URL guards share (user MCP URLs,
// model-chosen fetch targets): an address a public client could not reach
// is refused.

import { isIP } from "node:net";

/** True when `address` (an IP literal, optionally bracketed) is private,
 *  loopback, link-local, unique-local, this-network, CGNAT, benchmarking,
 *  multicast or reserved. IPv4-mapped IPv6, in dotted (`::ffff:127.0.0.1`)
 *  or hex (`::ffff:7f00:1`, the URL parser's form) notation, takes the IPv4
 *  rules. A host name is not an address and reads false. */
export function isNonPublicAddress(address: string): boolean {
  const h = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const dottedMapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (dottedMapped !== null) return isNonPublicAddress(dottedMapped[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hexMapped !== null) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return isNonPublicAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(h) === 6) {
    if (h === "::1" || h === "::") return true;
    const first = parseInt(h.split(":")[0] || "0", 16);
    // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
    return (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xfc00 && first <= 0xfdff) || first >= 0xff00;
  }
  return false;
}
