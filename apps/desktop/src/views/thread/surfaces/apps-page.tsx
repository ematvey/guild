// The Apps page: the member's Apps and the open one, addressed by the apps
// route.
import { AppsPage } from "../../apps/AppsPage";
import type { AppsRoute } from "../../apps/apps-route";
import { SURFACE_BASE } from "../route";
import type { PushRoute } from "../hooks/use-thread-route";

export function AppsSurface({
  route,
  isMobile,
  pushRoute,
  onOpenChat,
}: {
  route: AppsRoute;
  isMobile: boolean;
  pushRoute: PushRoute;
  onOpenChat: (chatId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppsPage
        route={route}
        isMobile={isMobile}
        onOpenChat={onOpenChat}
        navigate={(next, options) =>
          pushRoute({ ...SURFACE_BASE, skills: null, agents: null, integrations: null, apps: next }, options)
        }
      />
    </div>
  );
}
