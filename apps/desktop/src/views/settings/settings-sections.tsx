//! Guild settings sections: the section catalog plus the inline pane the
//! rail's Settings tab renders in the main column. User sections for
//! everyone; org sections appear for admins.

import {
  Bell,
  Bot,
  Building2,
  Cpu,
  Info,
  KeyRound,
  Layers,
  Palette,
  Sparkles,
  User,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react";
import type { UsageQuery } from "./usage-route";
import { canonicalSettings, isAdminSection, type SettingsSectionId } from "./section-nav";
import { useTheme } from "../../theme";
import { PageHeader } from "../../components/page-header";
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
import McpSection from "./sections/McpSection";
import SsoSection from "./sections/SsoSection";
import RegistrySection from "./sections/RegistrySection";
import { NotificationsSection } from "./sections/NotificationsSection";

// No "releases" pane: desktop releases are dev-controlled, not
// admin-controlled.
type SectionId = SettingsSectionId;

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
  group: "user" | "workspace";
  /** Admin-only, from `isAdminSection`: hidden from a member's nav and
   *  never rendered for one. */
  admin: boolean;
}

/// The section catalog: the sidebar rail's Settings tab nav plus the inline
/// main-pane rendering.
export const SETTINGS_SECTIONS: SectionDef[] = (
  [
    { id: "account", label: "Account", icon: <User className="size-4" />, group: "user" },
    { id: "appearance", label: "Appearance", icon: <Palette className="size-4" />, group: "user" },
    { id: "notifications", label: "Notifications", icon: <Bell className="size-4" />, group: "user" },
    { id: "machine", label: "Machines", icon: <Cpu className="size-4" />, group: "user" },
    { id: "gateway", label: "Gateway", icon: <KeyRound className="size-4" />, group: "user" },
    { id: "about", label: "About", icon: <Info className="size-4" />, group: "user" },
    { id: "general", label: "General", icon: <Building2 className="size-4" />, group: "workspace" },
    { id: "usage", label: "Usage", icon: <Sparkles className="size-4" />, group: "workspace" },
    { id: "assistant", label: "Assistant", icon: <Bot className="size-4" />, group: "workspace" },
    { id: "users", label: "Users", icon: <Users className="size-4" />, group: "workspace" },
    { id: "teams", label: "Teams", icon: <UsersRound className="size-4" />, group: "workspace" },
    { id: "models", label: "Models", icon: <Waypoints className="size-4" />, group: "workspace" },
    { id: "mcp", label: "MCP servers", icon: <Waypoints className="size-4" />, group: "user" },
    { id: "sso", label: "Sign-in / SSO", icon: <KeyRound className="size-4" />, group: "workspace" },
    { id: "registry", label: "Registry", icon: <Layers className="size-4" />, group: "workspace" },
  ] satisfies Omit<SectionDef, "admin">[]
).map((s) => ({ ...s, admin: isAdminSection(s.id) }));

/// Section content for embedding outside the overlay: the sidebar rail's
/// Settings tab renders this pane in the main column. An unknown id, or an
/// admin section for a non-admin viewer, renders the default section.
export function SettingsSectionPane({
  sectionId,
  email,
  role,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  sectionId: string;
  email: string;
  /** The viewer's workspace role, as the session reported it. */
  role: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: UsageQuery;
  onUsageChange: (usage: UsageQuery) => void;
}) {
  // The pane renders the section the canonical address names, so a member
  // on an admin address sees (and fetches for) the default section only.
  const shownId = canonicalSettings(sectionId, null, role).section;
  const def = SETTINGS_SECTIONS.find((s) => s.id === shownId) ?? SETTINGS_SECTIONS[0];
  return (
    <SectionPane
      def={def}
      email={email}
      role={role}
      detail={shownId === sectionId ? detail : null}
      onDetailChange={onDetailChange}
      usage={usage}
      onUsageChange={onUsageChange}
    />
  );
}

function SectionPane({
  def,
  email,
  role,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  def: SectionDef;
  email: string;
  role: string;
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
        role={role}
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
  role,
  detail,
  onDetailChange,
  usage,
  onUsageChange,
}: {
  id: SectionId;
  email: string;
  role: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
  usage: UsageQuery;
  onUsageChange: (usage: UsageQuery) => void;
}) {
  switch (id) {
    case "general":
      return <GeneralSection />;
    case "account":
      return <AccountSection email={email} role={role} />;
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
    case "registry":
      return <RegistrySection detail={detail} onDetailChange={onDetailChange} />;
    case "about":
      return <AboutSection />;
  }
}

function AccountSection({ email, role }: { email: string; role: string }) {
  return (
    <div className="space-y-5">
      <PageHeader title="Account" description="Your sign-in and role in this workspace." />
      <FactGrid>
        <FactCard label="Email">
          <p className="break-all text-sm">{email}</p>
        </FactCard>
        <FactCard label="Role">
          <div className="text-sm capitalize">{role}</div>
        </FactCard>
      </FactGrid>
      <div className="text-sm text-muted-foreground">
        {role === "admin"
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
      <PageHeader title="Appearance" description="Light, dark, or follow the OS; applies to this device." />
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
