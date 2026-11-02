// VAPID identity for Web Push: the key pair that signs every push and names
// this server to the push services. Generated once on first use and kept in
// the server-wide KV, so a redeploy keeps the same identity and existing
// subscriptions keep working.

import webpush from "web-push";
import type { KvStore } from "../platform/store/org-kv.js";

/** server_kv keys holding the push identity. */
export const VAPID_PUBLIC_KEY = "push_vapid_public_key";
export const VAPID_PRIVATE_KEY = "push_vapid_private_key";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Loads the server's VAPID pair, minting and persisting it on first use.
 *  Two callers race on a cold server: both mint, one wins the write, and the
 *  loser re-reads, so every process ends up with the stored pair. */
export async function vapidKeys(kv: KvStore): Promise<VapidKeys> {
  const stored = await read(kv);
  if (stored !== null) return stored;
  const minted = webpush.generateVAPIDKeys();
  await kv.put(VAPID_PRIVATE_KEY, minted.privateKey);
  await kv.put(VAPID_PUBLIC_KEY, minted.publicKey);
  return (await read(kv)) ?? minted;
}

async function read(kv: KvStore): Promise<VapidKeys | null> {
  const [publicKey, privateKey] = await Promise.all([kv.get(VAPID_PUBLIC_KEY), kv.get(VAPID_PRIVATE_KEY)]);
  if (publicKey === null || privateKey === null) return null;
  return { publicKey, privateKey };
}

/** The push subject: a contact the push services can reach about this
 *  sender. VAPID accepts only an https: or mailto: URL, so a plain-http
 *  deployment (a container's own loopback base) falls back to a mailto built
 *  from the public host — the contact is informational, the scheme is not. */
export function pushSubject(config: { apiUrl: string }): string {
  try {
    const url = new URL(config.apiUrl);
    if (url.protocol === "https:") return url.origin;
    return `mailto:guild@${url.hostname === "" ? "localhost" : url.hostname}`;
  } catch {
    return "mailto:guild@localhost";
  }
}
