// The integrations page (admin): installed integrations, the catalog and
// its landing pages, addressed by the integrations route.
import { IntegrationsPage } from "../../integrations/IntegrationsPage";
import type { IntegrationsRoute } from "../../integrations/integrations-route";
import { SURFACE_BASE } from "../route";
import type { PushRoute } from "../hooks/use-thread-route";

export function IntegrationsSurface({
  route,
  isMobile,
  pushRoute,
}: {
  route: IntegrationsRoute;
  isMobile: boolean;
  pushRoute: PushRoute;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <IntegrationsPage
        route={route}
        isMobile={isMobile}
        navigate={(next, options) =>
          pushRoute({ ...SURFACE_BASE, skills: null, agents: null, integrations: next }, options)
        }
      />
    </div>
  );
}
