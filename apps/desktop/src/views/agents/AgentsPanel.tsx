import { AgentsDirectory } from "./AgentsDirectory";
import { AgentCreate } from "./AgentCreate";
import { AgentPage, type Viewer } from "./AgentPage";
import { ActivityPage, ConversationPage, RunDetailPage } from "./ActivityPage";
import type { AgentsRoute } from "./agents-route";

/** The agents surface's main-column page. Every visible page derives from
 *  the URL route; user navigation goes back through onNavigate. */
export function AgentsPanel({
  route,
  viewer,
  onNavigate,
  onOpenChat,
  onRefreshConversation,
}: {
  route: AgentsRoute;
  viewer: Viewer;
  /** `replace` corrects the current address instead of adding a step. */
  onNavigate: (route: AgentsRoute, options?: { replace?: boolean }) => void;
  onOpenChat?: (chatId: string) => void;
  onRefreshConversation: () => void;
}) {
  switch (route.view) {
    case "directory":
      return <AgentsDirectory onNavigate={onNavigate} />;
    case "new":
      return <AgentCreate step={route.step ?? "name"} onNavigate={onNavigate} />;
    case "agent":
      return (
        <AgentPage
          agentId={route.agentId}
          tab={route.tab}
          routineId={route.routineId}
          filePath={route.filePath}
          filters={route.filters}
          viewer={viewer}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
          onResync={onRefreshConversation}
        />
      );
    case "activity":
      return (
        <ActivityPage
          filters={route.filters}
          role={viewer.role}
          onFiltersChange={(filters, options) => onNavigate({ view: "activity", filters }, options)}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      );
    case "run":
      return (
        <RunDetailPage
          key={`run:${route.runId}`}
          runId={route.runId}
          view={route.traceView ?? "transcript"}
          role={viewer.role}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      );
    case "trace":
      return (
        <RunDetailPage
          key={`trace:${route.traceId}`}
          runId={route.traceId}
          traceOnly
          view={route.traceView ?? "transcript"}
          role={viewer.role}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      );
    case "chat":
      return (
        <ConversationPage
          key={route.chatId}
          onResync={onRefreshConversation}
          chatId={route.chatId}
          role={viewer.role}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      );
  }
}
