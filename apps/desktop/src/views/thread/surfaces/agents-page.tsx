// The agents surface: directory, agent pages and activity, addressed by
// the agents route.
import { useCallback } from "react";
import { AgentsPanel } from "../../agents/AgentsPanel";
import type { AgentsRoute } from "../../agents/agents-route";
import { SURFACE_BASE } from "../route";
import type { PushRoute } from "../hooks/use-thread-route";

export function AgentsPage({
  route,
  viewer,
  pushRoute,
  onOpenChat,
}: {
  route: AgentsRoute;
  viewer: { email: string; displayName?: string | null; role: string };
  pushRoute: PushRoute;
  onOpenChat: (chatId: string) => void;
}) {
  const navigate = useCallback(
    (next: AgentsRoute, options?: { replace?: boolean }) =>
      pushRoute({ ...SURFACE_BASE, skills: null, agents: next }, options),
    [pushRoute],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-scrollable>
      <AgentsPanel route={route} viewer={viewer} onNavigate={navigate} onOpenChat={onOpenChat} />
    </div>
  );
}
