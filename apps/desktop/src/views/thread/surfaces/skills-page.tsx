// The Skills page: catalog, activity, machine tab, detail and editor,
// all addressed by the skills route.
import { HAS_ENGINE } from "../../../lib/session";
import { SkillsPanel } from "../../skills/SkillsPanel";
import { clampSkillsRoute, type SkillsRoute } from "../../skills/skills-route";
import { SURFACE_BASE } from "../route";
import type { PushRoute } from "../hooks/use-thread-route";

/** The skills page, clamped to what this session can render (the machine
 *  tab needs the desktop fs bridge). */
export function SkillsPage({
  route,
  me,
  pushRoute,
}: {
  route: SkillsRoute;
  me: { email: string; displayName?: string; role: string };
  pushRoute: PushRoute;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-scrollable>
      <SkillsPanel
        me={me}
        route={clampSkillsRoute(route, HAS_ENGINE)}
        onNavigate={(next: SkillsRoute, options?: { replace?: boolean }) =>
          pushRoute({
            ...SURFACE_BASE,
            skills: route.management && next.view !== "machine" ? { ...next, management: true } : next,
          }, options)
        }
      />
    </div>
  );
}
