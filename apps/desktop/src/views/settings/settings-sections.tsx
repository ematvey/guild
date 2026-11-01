//! Guild settings sections: the section catalog plus the inline pane the
//! rail's Settings tab renders in the main column. User sections for
//! everyone; org sections appear for admins.

import { Skeleton } from "@guild/ui/components/skeleton";
import { useEffect, useState } from "react";
import {
  Bell,
  Bot,
  Building2,
  Cpu,
  Info,
  KeyRound,
  Layers,
  Palette,
  Plug,
  Sparkles,
  User,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { apiMe } from "../../lib/api/servers";
import type { UsageQuery } from "./usage-route";
import { useTheme } from "../../theme";
import { PageHeader } from "./components/page-header";
import { FactCard, FactGrid } from "./components/fact-card";
import { MachineSection } from "./sections/MachineSection";
import { GatewaySection } from "./sections/GatewaySection";
import { AboutSection } from "./sections/AboutSection";
import { AssistantSection } from "./sections/AssistantSection";
import GeneralSection from "./sections/GeneralSection";
import UsageSection from "./sections/UsageSection";
import UsersSection from "./sections/UsersSection";
import TeamsSection from "./sections/TeamsSection";
import ModelsSection from "./sections/ModelsSection";
import IntegrationsSection from "./sections/IntegrationsSection";
import McpSection from "./sections/McpSection";
import SsoSection from "./sections/SsoSection";
import RegistrySection from "./sections/RegistrySection";
import { NotificationsSection } from "./sections/NotificationsSection";

type SectionId =
  | "account"
  | "appearance"
  | "notifications"
  | "machine"
  | "gateway"
  | "general"
  | "usage"
  | "assistant"
  | "users"
  | "teams"
  | "models"
  | "integrations"
  | "mcp"
  | "sso"
  | "registry"
  | "about";
  // No "releases" pane: desktop releases are dev-controlled, not
  // admin-controlled.

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
  group: "user" | "workspace";
  admin?: boolean;
}

/// The section catalog: the sidebar rail's Settings tab nav plus the inline
/// main-pane rendering.
export const SETTINGS_SECTIONS: SectionDef[] = [
  { id: "account", label: "Account", icon: <User className="size-4" />, group: "user" },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" />, group: "user" },
  { id: "notifications", label: "Notifications", icon: <Bell className="size-4" />, group: "user" },
  { id: "machine", label: "Machines", icon: <Cpu className="size-4" />, group: "user" },
  { id: "gateway", label: "Gateway", icon: <KeyRound className="size-4" />, group: "user" },
  { id: "about", label: "About", icon: <Info className="size-4" />, group: "user" },
  { id: "general", label: "General", icon: <Building2 className="size-4" />, group: "workspace", admin: true },
  { id: "usage", label: "Usage", icon: <Sparkles className="size-4" />, group: "workspace", admin: true },
  { id: "assistant", label: "Assistant", icon: <Bot className="size-4" />, group: "workspace", admin: true },
  { id: "users", label: "Users", icon: <Users className="size-4" />, group: "workspace", admin: true },
  { id: "teams", label: "Teams", icon: <UsersRound className="size-4" />, group: "workspace", admin: true },
  { id: "models", label: "Models", icon: <Waypoints className="size-4" />, group: "workspace", admin: true },
  {
    id: "integrations",
    label: "Integrations",
    icon: <Plug className="size-4" />,
    group: "workspace",
    admin: true,
  },
  { id: "mcp", label: "MCP servers", icon: <Waypoints className="size-4" />, group: "user" },
  { id: "sso", label: "Sign-in / SSO", icon: <KeyRound className="size-4" />, group: "workspace", admin: true },
  { id: "registry", label: "Registry", icon: <Layers className="size-4" />, group: "workspace", admin: true },
];

/// Section content for embedding outside the overlay: the sidebar rail's
/// Settings tab renders this pane in the main column. Unknown ids fall back
/// to the first section (same fallback the overlay uses for stale links).
export function SettingsSectionPane({
  sectionId,
  email,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  sectionId: string;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: UsageQuery;
  onUsageChange: (usage: UsageQuery) => void;
}) {
  const def =
    SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0];
  return (
    <SectionPane
      def={def}
      email={email}
      detail={detail}
      onDetailChange={onDetailChange}
      usage={usage}
      onUsageChange={onUsageChange}
    />
  );
}

function SectionPane({
  def,
  email,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  def: SectionDef;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: UsageQuery;
  onUsageChange: (usage: UsageQuery) => void;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <SectionBody
        id={def.id}
        email={email}
        detail={detail}
        onDetailChange={onDetailChange}
        usage={usage}
        onUsageChange={onUsageChange}
      />
    </div>
  );
}

function SectionBody({
  id,
  email,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  id: SectionId;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: UsageQuery;
  onUsageChange: (usage: UsageQuery) => void;
}) {
  switch (id) {
    case "general":
      return <GeneralSection />;
    case "account":
      return <AccountSection email={email} />;
    case "appearance":
      return <AppearanceSection />;
    case "notifications":
      return <NotificationsSection />;
    case "machine":
      return <MachineSection />;
    case "gateway":
      return <GatewaySection />;
    case "usage":
      return (
        <UsageSection
          detail={detail}
          onDetailChange={onDetailChange}
          usage={usage}
          onUsageChange={onUsageChange}
        />
      );
    case "assistant":
      return <AssistantSection />;
    case "users":
      return <UsersSection detail={detail} onDetailChange={onDetailChange} />;
    case "teams":
      return <TeamsSection detail={detail} onDetailChange={onDetailChange} />;
    case "models":
      return <ModelsSection detail={detail} onDetailChange={onDetailChange} />;
    case "integrations":
      return <IntegrationsSection detail={detail} onDetailChange={onDetailChange} />;
    case "mcp":
      return <McpSection detail={detail} onDetailChange={onDetailChange} />;
    case "sso":
      return <SsoSection />;
    case "registry":
      return <RegistrySection detail={detail} onDetailChange={onDetailChange} />;
    case "about":
      return <AboutSection />;
  }
}

function AccountSection({ email }: { email: string }) {
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    apiMe().then((u) => setRole(u?.role ?? "member"));
  }, []);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Account"
        description="Your sign-in and role in this workspace."
      />
      <FactGrid>
        <FactCard label="Email">
          <p className="break-all text-sm">{email}</p>
        </FactCard>
        <FactCard label="Role">
          <div className="text-sm capitalize">{role === null ? <Skeleton className="h-4 w-20" /> : role}</div>
        </FactCard>
      </FactGrid>
      <div className="text-sm text-muted-foreground">
        {role === null ? <Skeleton className="h-3 w-64 max-w-full" /> : role === "admin"
          ? "You can configure the workspace: users, teams, models, integrations and registry."
          : "Ask a workspace admin for model or integration changes."}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const options: { id: string; label: string; hint: string }[] = [
    { id: "light", label: "Light", hint: "Warm beige sidebar, white canvas" },
    { id: "dark", label: "Dark", hint: "Near-black canvas, warm sidebar" },
    { id: "system", label: "System", hint: "Follow the OS setting" },
  ];
  return (
    <div className="space-y-5">
      <PageHeader
        title="Appearance"
        description="Light, dark, or follow the OS; applies to this device."
      />
      <div className="max-w-xl space-y-3">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={() => setTheme(o.id as "light" | "dark" | "system")}
            className={`flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors ${
              theme === o.id ? "border-foreground/40 bg-accent" : "border-border bg-card hover:bg-accent/50"
            }`}
          >
            <div>
              <p className="text-sm font-medium">{o.label}</p>
              <p className="text-xs text-muted-foreground">{o.hint}</p>
            </div>
            <div
              className={`size-4 rounded-full border-2 ${
                theme === o.id ? "border-foreground bg-foreground" : "border-border"
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

