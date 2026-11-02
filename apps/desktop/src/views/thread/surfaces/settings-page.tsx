// The Settings tab's page: the picked section in the main column.
import type { PushRoute } from "../hooks/use-thread-route";
import { SettingsSectionPane } from "../../settings/settings-sections";
import type { UsageQuery } from "../../settings/usage-route";

/** The Settings tab's main pane: the picked section inline (on mobile too,
 *  so the drawer's Settings tab leads to a page). The section and its
 *  sub-page live in the route — every pick navigates. */
export function SettingsPage({
  section,
  detail,
  usage,
  email,
  role,
  pushRoute,
}: {
  section: string;
  detail: string | null;
  usage: UsageQuery;
  email: string;
  role: string;
  pushRoute: PushRoute;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
      <SettingsSectionPane
        sectionId={section}
        email={email}
        role={role}
        detail={detail}
        // A sub-page opens on /settings/<section>/<detail>; closing it
        // returns to the bare section address.
        onDetailChange={(next) => pushRoute({ tab: "settings", settingsDetail: next })}
        usage={usage}
        onUsageChange={(next) => pushRoute({ usage: next })}
      />
    </div>
  );
}
