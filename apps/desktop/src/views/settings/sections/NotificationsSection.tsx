//! Notifications — Web Push for this device. The switch is per device (a
//! phone and a laptop are different endpoints); the server decides what is
//! worth sending. Enabling must run from the click: browsers reject a
//! permission prompt without a user gesture.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { PageHeader } from "../../../components/page-header";
import {
  currentSubscription,
  disablePush,
  enablePush,
  notificationPermission,
  pushBlocker,
  pushErrorMessage,
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
        toast.error(pushErrorMessage(result.error));
      } else {
        toast.success(device === "on" ? "Notifications off for this device" : "Notifications on for this device");
      }
    } finally {
      setPermission(notificationPermission());
      refresh();
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader inlineActions title="Notifications" description="Manage alerts when an agent finishes a run." />
      <div className="divide-y divide-border">
        <section className="space-y-2 py-3">
          <h2 className="font-semibold">This device</h2>
          <div className="flex items-center justify-between gap-3">
            <span className="text-base text-muted-foreground">
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
        </section>
        <section className="space-y-2 py-3">
          <h2 className="font-semibold">Devices on this account</h2>
          {rows === null ? (
            <span className="text-base text-muted-foreground">Unavailable</span>
          ) : rows.length === 0 ? (
            <span className="text-base text-muted-foreground">None</span>
          ) : (
            <ul className="divide-y divide-border text-base text-muted-foreground">
              {rows.map((row) => (
                <li key={row.device_id} className="py-2">
                  {row.platform === "android" ? "Android" : "Browser"} · registered{" "}
                  {new Date(row.created_at).toLocaleDateString()}
                  {row.last_error !== null && <span className="text-destructive"> · last error: {row.last_error}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
