import { AgentsDirectory } from "./AgentsDirectory";
import { AgentCreate } from "./AgentCreate";
import { AgentPage, type Viewer } from "./AgentPage";
import { ActivityPage, ChatActivityPage, RunDetailPage } from "./ActivityPage";
import type { AgentsRoute } from "./agents-route";

/** The agents surface's main-column page. Every visible page derives from
 *  the URL route; user navigation goes back through onNavigate. */
export function AgentsPanel({
  route,
  viewer,
  onNavigate,
  onOpenChat,
}: {
  route: AgentsRoute;
  viewer: Viewer;
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
}) {
  switch (route.view) {
    case "directory":
      return <AgentsDirectory onNavigate={onNavigate} />;
    case "new":
      return <AgentCreate onNavigate={onNavigate} />;
    case "agent":
      return (
        <AgentPage
          agentId={route.agentId}
          tab={route.tab}
          routineId={route.routineId}
          filePath={route.filePath}
          viewer={viewer}
          onNavigate={onNavigate}
          onOpenChat={onOpenChat}
        />
      );
    case "activity":
      return <ActivityPage onNavigate={onNavigate} onOpenChat={onOpenChat} />;
    case "run":
      return <RunDetailPage runId={route.runId} onNavigate={onNavigate} onOpenChat={onOpenChat} />;
    case "chat":
      return <ChatActivityPage chatId={route.chatId} onNavigate={onNavigate} onOpenChat={onOpenChat} />;
  }
}
