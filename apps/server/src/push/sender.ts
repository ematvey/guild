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

export function webPushSender(keys: VapidKeys, subject: string): PushSender {
  return {
    async send(sub, payload, topic) {
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
