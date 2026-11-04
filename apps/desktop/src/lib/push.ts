// Web Push on this device: register the service worker, ask for permission,
// subscribe, and hand the subscription to the server. The server decides what
// is worth a notification; this module only owns the device side.
//
// Not available in the desktop shell: a Tauri webview has no push service,
// and the desktop client is already open when it matters.

import { getPushConfig, postPushSubscribe, postPushUnsubscribe, postPushTest } from "./api/settings";
import { HAS_SHELL } from "./session";

/** Why a device cannot receive notifications, or null when it can. */
export type PushBlocker = "desktop" | "unsupported" | "insecure" | "ios-not-installed";

const DEVICE_KEY = "guild.push.device_id";

/** The reason this device cannot use Web Push, or null. iOS only delivers
 *  push to a web app added to the Home Screen, so a Safari tab reads as
 *  "install first" instead of a silent no-op. */
/** Register the worker on boot in the browser app. The registration must
 *  outlive a reload — a push subscription dies with it — and an installed
 *  app needs it for installability and offline launches. */
export function ensureServiceWorker(): void {
  if (HAS_SHELL || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}

export function pushBlocker(): PushBlocker | null {
  if (HAS_SHELL) return "desktop";
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  // A push service needs a secure origin; localhost is the one exception.
  const host = window.location.hostname;
  const secure = window.location.protocol === "https:" || host === "localhost" || host === "127.0.0.1";
  if (!secure) return "insecure";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "ios-not-installed";
  return null;
}

/** Stable id for this install: the server keys one row per device, so a
 *  re-subscribe replaces the old endpoint instead of piling up. */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing !== null && existing !== "") return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return "unknown";
  }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing !== undefined) return existing;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

/** The current subscription, if this device already has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushBlocker() !== null) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Hands one subscription to the server. The row is keyed by device, so a
 *  repeat replaces it. */
async function registerSubscription(sub: PushSubscription): Promise<{ ok: true } | { ok: false; error: string }> {
  const json = sub.toJSON();
  const keys = json.keys ?? {};
  if (json.endpoint === undefined || keys.p256dh === undefined || keys.auth === undefined) {
    return { ok: false, error: "subscription has no keys" };
  }
  await postPushSubscribe({
    device_id: deviceId(),
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    platform: navigator.userAgent.includes("Android") ? "android" : "web",
  });
  return { ok: true };
}

/** Registers this device's existing subscription with the server again. The
 *  server drops a row whose endpoint the push service reported dead, and a
 *  restored database loses every row; the browser keeps its subscription
 *  through both, so without this the device stays silent with no switch to
 *  turn on. Runs on boot, after the worker is ready. */
export async function resubmitSubscription(): Promise<void> {
  if (pushBlocker() !== null || notificationPermission() !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub !== null) await registerSubscription(sub);
  } catch {
    /* a device that cannot resubmit keeps whatever the server already has */
  }
}

/** Subscribes this device. Must be called from a user gesture: browsers
 *  reject a permission prompt without one. */
export async function enablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  const blocker = pushBlocker();
  if (blocker !== null) return { ok: false, error: blocker };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, error: permission === "denied" ? "blocked" : "dismissed" };
  }
  try {
    const reg = await registration();
    const { public_key: publicKey } = await getPushConfig();
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
    return await registerSubscription(sub);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Removes this device: the push service drops the endpoint and the server
 *  forgets the row. */
export async function disablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  const sub = await currentSubscription();
  if (sub === null) return { ok: true };
  try {
    await postPushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function sendTestPush(): Promise<{ ok: boolean; delivered: number }> {
  return postPushTest();
}

/** VAPID keys travel base64url; `applicationServerKey` wants bytes. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
