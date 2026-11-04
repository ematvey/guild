// The in-app offer for notifications: an installed app shows it once, above
// the thread, and the tap is the user gesture a browser demands for the
// permission prompt. An install cannot subscribe itself.

import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { dismissNotificationsOffer, enablePush, notificationsOfferWanted, pushErrorMessage } from "../../lib/push";

export function NotificationsOffer() {
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void notificationsOfferWanted().then((wanted) => {
      if (live) setShown(wanted);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!shown) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      if (result.ok) {
        toast.success("Notifications on for this device");
        setShown(false);
      } else {
        toast.error(pushErrorMessage(result.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    dismissNotificationsOffer();
    setShown(false);
  };

  return (
    <div role="status" className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
      <BellRing className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        Get a notification when a run finishes while the app is closed.
      </span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void enable()}>
        Turn on
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        className="rounded p-1 text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground"
        onClick={dismiss}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
