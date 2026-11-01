// The Web Push sender: signs a payload with the server's VAPID pair and
// posts it to the browser's push service. One call per subscription row; the
// caller decides which rows to hit and what the payload says.

import webpush from "web-push";
import type { PushSubscriptionRow } from "../platform/store/push.js";
import type { VapidKeys } from "./vapid.js";

/** How long the push service keeps an undelivered message. */
const TTL_SECONDS = 6 * 60 * 60;

/** What the service worker receives. Deliberately small and content-free for
 *  agent output: the notification is a hint to open the thread. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path the click opens. */
  url: string;
  tag?: string;
  /** Which chat, so the client can sync just that one. */
  chat_id?: string;
}

/** `gone` means the endpoint is dead (404/410) and the row must go. */
export interface PushResult {
  outcome: "ok" | "gone" | "failed";
  error?: string;
}

export interface PushSender {
  send(
    sub: Pick<PushSubscriptionRow, "endpoint" | "p256dh" | "auth">,
    payload: PushPayload,
    topic?: string,
  ): Promise<PushResult>;
}

/** Hosts of the browser push services: Chrome/Edge-on-Android (FCM),
 *  Firefox (Mozilla autopush), Safari (Apple), and Edge/Windows (WNS). An
 *  endpoint is a URL the client hands the server to POST to; anything else
 *  would let a member point the server's requests at internal hosts. */
const PUSH_SERVICE_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

/** True when `endpoint` is an https URL on a known push service, on the
 *  default port, without credentials. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((pattern) => pattern.test(host));
}

/** `allowEndpoint` gates every send; a refused endpoint reports `gone`, so
 *  the row is dropped instead of retried. */
export function webPushSender(
  keys: VapidKeys,
  subject: string,
  allowEndpoint: (endpoint: string) => boolean = isPushServiceEndpoint,
): PushSender {
  return {
    async send(sub, payload, topic) {
      if (!allowEndpoint(sub.endpoint)) return { outcome: "gone", error: "endpoint is not a known push service" };
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          {
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: TTL_SECONDS,
            urgency: "normal",
            ...(topic === undefined ? {} : { topic }),
          },
        );
        return { outcome: "ok" };
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = describe(error);
        if (status === 404 || status === 410) return { outcome: "gone", error: message };
        return { outcome: "failed", error: message };
      }
    },
  };
}

function describe(error: unknown): string {
  const status = (error as { statusCode?: number }).statusCode;
  const body = (error as { body?: string }).body;
  const head = typeof status === "number" ? String(status) : "";
  const tail = typeof body === "string" ? body.trim() : "";
  const message =
    [head, tail].filter((part) => part !== "").join(" ") ||
    (error instanceof Error ? error.message : String(error));
  return message.slice(0, 200);
}
