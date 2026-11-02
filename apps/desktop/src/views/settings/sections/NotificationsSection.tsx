//! Notifications — Web Push for this device. The switch is per device (a
//! phone and a laptop are different endpoints); the server decides what is
//! worth sending. Enabling must run from the click: browsers reject a
//! permission prompt without a user gesture.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { PageHeader } from "../../../components/page-header";
import { FactCard, FactGrid } from "../components/fact-card";
import {
  currentSubscription,
  disablePush,
  enablePush,
  notificationPermission,
  pushBlocker,
  sendTestPush,
  type PushBlocker,
} from "../../../lib/push";
import { getPushSubscriptions, type PushSubscriptionInfo } from "../../../lib/api/settings";

type DeviceState = "checking" | "on" | "off";

const BLOCKER_TEXT: Record<PushBlocker, string> = {
  desktop: "The desktop app has no push service. Notifications work in the browser app.",
  unsupported: "This browser does not support Web Push.",
  insecure: "Notifications need an HTTPS page.",
  "ios-not-installed":
    "On iPhone and iPad, add this page to the Home Screen first (Share → Add to Home Screen), then open it from there.",
};

export function NotificationsSection() {
  const [device, setDevice] = useState<DeviceState>("checking");
  const [permission, setPermission] = useState(notificationPermission());
  const [blocker] = useState<PushBlocker | null>(() => pushBlocker());
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<PushSubscriptionInfo[] | null>(null);

  const refresh = useCallback(() => {
    void currentSubscription().then((sub) => setDevice(sub === null ? "off" : "on"));
    void getPushSubscriptions()
      .then((r) => setRows(r.subscriptions))
      .catch(() => setRows(null));
  }, []);

  useEffect(refresh, [refresh]);

  const toggle = async () => {
    setBusy(true);
    try {
      const result = device === "on" ? await disablePush() : await enablePush();
      if (!result.ok) {
        const message =
          result.error === "blocked"
            ? "Notifications are blocked for this site. Allow them in the browser's site settings."
            : result.error === "dismissed"
              ? "The permission prompt was dismissed."
              : result.error;
        toast.error(message);
      } else {
        toast.success(device === "on" ? "Notifications off for this device" : "Notifications on for this device");
      }
    } finally {
      setPermission(notificationPermission());
      refresh();
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const result = await sendTestPush();
      if (result.delivered === 0) toast.error("No device is registered for this account");
      else toast.success(`Sent to ${result.delivered} device${result.delivered === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" />
      <FactGrid>
        <FactCard label="This device">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {blocker !== null
                ? BLOCKER_TEXT[blocker]
                : device === "checking"
                  ? "Checking…"
                  : device === "on"
                    ? "On — this device gets a notification when a run finishes while the app is closed."
                    : permission === "denied"
                      ? "Blocked by the browser. Allow notifications for this site in its settings."
                      : "Off. Nothing is sent to this device."}
            </span>
            {blocker === null && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || device === "checking" || permission === "denied"}
                onClick={() => void toggle()}
              >
                {device === "on" ? "Turn off" : "Turn on"}
              </Button>
            )}
          </div>
        </FactCard>
        <FactCard label="Devices on this account">
          {rows === null ? (
            <span className="text-sm text-muted-foreground">Unavailable</span>
          ) : rows.length === 0 ? (
            <span className="text-sm text-muted-foreground">None</span>
          ) : (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {rows.map((row) => (
                <li key={row.device_id}>
                  {row.platform === "android" ? "Android" : "Browser"} · registered{" "}
                  {new Date(row.created_at).toLocaleDateString()}
                  {row.last_error !== null && <span className="text-destructive"> · last error: {row.last_error}</span>}
                </li>
              ))}
            </ul>
          )}
        </FactCard>
      </FactGrid>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || rows === null || rows.length === 0}
          onClick={() => void test()}
        >
          <BellRing className="mr-1 size-3.5" />
          Send a test notification
        </Button>
        <span className="text-sm text-muted-foreground">
          The notification says which thread and how the run ended. It never carries the answer.
        </span>
      </div>
    </div>
  );
}
