import { GatewaySection } from "./settings/GatewaySection";
import { AssistantSection } from "./settings/AssistantSection";
import GeneralSection from "./settings/GeneralSection";
import UsageSection from "./settings/UsageSection";
import UsersSection from "./settings/UsersSection";
import TeamsSection from "./settings/TeamsSection";
import ModelsSection from "./settings/ModelsSection";
import McpSection from "./settings/McpSection";
import SsoSection from "./settings/SsoSection";
import SecuritySection from "./settings/SecuritySection";
import RegistrySection from "./settings/RegistrySection";
import type { ChatRoute } from "../../desktop/src/views/thread/route";
import type { PushRoute } from "../../desktop/src/views/thread/hooks/use-thread-route";

export function ControlSettings({ route, pushRoute }: { route: ChatRoute; pushRoute: PushRoute }) {
  const detail = route.settingsDetail;
  const onDetailChange = (settingsDetail: string | null) => pushRoute({ tab: "settings", settingsDetail });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-6 sm:px-8 sm:pb-8">
        <SettingsBody
          section={route.settingsSection}
          detail={detail}
          onDetailChange={onDetailChange}
          usage={route.usage}
          onUsageChange={(usage) => pushRoute({ usage })}
        />
      </div>
    </div>
  );
}

function SettingsBody({
  section,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  section: string | null;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: ChatRoute["usage"];
  onUsageChange: (usage: ChatRoute["usage"]) => void;
}) {
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "gateway":
      return <GatewaySection />;
    case "usage":
      return (
        <UsageSection detail={detail} onDetailChange={onDetailChange} usage={usage} onUsageChange={onUsageChange} />
      );
    case "assistant":
      return <AssistantSection />;
    case "users":
      return <UsersSection detail={detail} onDetailChange={onDetailChange} />;
    case "teams":
      return <TeamsSection detail={detail} onDetailChange={onDetailChange} />;
    case "models":
      return <ModelsSection detail={detail} onDetailChange={onDetailChange} />;
    case "mcp":
      return <McpSection detail={detail} onDetailChange={onDetailChange} />;
    case "sso":
      return <SsoSection />;
    case "security":
      return <SecuritySection />;
    case "registry":
      return <RegistrySection detail={detail} onDetailChange={onDetailChange} />;
    default:
      return null;
  }
}
