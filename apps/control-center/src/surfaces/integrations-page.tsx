// The integrations page (admin): installed integrations, the catalog and
// its landing pages, addressed by the integrations route.
import { IntegrationsPage } from "../integrations/IntegrationsPage";
import type { IntegrationsRoute } from "../../../desktop/src/views/integrations/integrations-route";
import { SURFACE_BASE } from "../../../desktop/src/views/thread/route";
import { agentTabRoute } from "../../../desktop/src/views/agents/agents-route";
import type { PushRoute } from "../../../desktop/src/views/thread/hooks/use-thread-route";

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
        openAgent={(agentId) =>
          pushRoute({
            ...SURFACE_BASE,
            skills: null,
            integrations: null,
            agents: agentTabRoute(agentId, "settings"),
          })
        }
      />
    </div>
  );
}
