//! Guild settings sections: the section catalog plus the inline pane the
//! rail's Settings tab renders in the main column. User sections for
//! everyone; org sections appear for admins. Sections are lazy-imported so
//! the chat bundle only pays for what opens.

import { Skeleton, SkeletonForm } from "@guild/ui/components/skeleton";
import { useEffect, useState } from "react";
import {
  Bot,
  Building2,
  Cpu,
  Info,
  KeyRound,
  Layers,
  Palette,
  Plug,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { apiMe } from "../../transport";
import type { SectionDetailProps } from "./section-nav";
import { useTheme } from "../../theme";
import { PageHeader } from "./components/page-header";
import { FactCard, FactGrid } from "./components/fact-card";
import { MachineSection } from "./sections/MachineSection";
import { GatewaySection } from "./sections/GatewaySection";
import { AboutSection } from "./sections/AboutSection";
import { ApprovalsSection } from "./sections/ApprovalsSection";
import { AssistantSection } from "./sections/AssistantSection";

type SectionId =
  | "account"
  | "appearance"
  | "machine"
  | "gateway"
  | "approvals"
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
  { id: "machine", label: "Machine", icon: <Cpu className="size-4" />, group: "user" },
  { id: "gateway", label: "Gateway", icon: <KeyRound className="size-4" />, group: "user" },
  {
    id: "approvals",
    label: "Approvals",
    icon: <ShieldCheck className="size-4" />,
    group: "user",
  },
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
}: {
  sectionId: string;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
}) {
  const def =
    SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0];
  return (
    <SectionPane def={def} email={email} detail={detail} onDetailChange={onDetailChange} />
  );
}

function SectionPane({
  def,
  email,
  detail,
  onDetailChange,
}: {
  def: SectionDef;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <SectionBody
        id={def.id}
        email={email}
        detail={detail}
        onDetailChange={onDetailChange}
      />
    </div>
  );
}

function SectionBody({
  id,
  email,
  detail,
  onDetailChange,
}: {
  id: SectionId;
  email: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
}) {
  switch (id) {
    case "general":
      return (
        <LazySection
          load={() => import("./sections/GeneralSection")}
          name="GeneralSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "account":
      return <AccountSection email={email} />;
    case "appearance":
      return <AppearanceSection />;
    case "machine":
      return <MachineSection />;
    case "gateway":
      return <GatewaySection />;
    case "approvals":
      return <ApprovalsSection />;
    case "usage":
      return (
        <LazySection
          load={() => import("./sections/UsageSection")}
          name="UsageSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "assistant":
      return <AssistantSection />;
    case "users":
      return (
        <LazySection
          load={() => import("./sections/UsersSection")}
          name="UsersSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "teams":
      return (
        <LazySection
          load={() => import("./sections/TeamsSection")}
          name="TeamsSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "models":
      return (
        <LazySection
          load={() => import("./sections/ModelsSection")}
          name="ModelsSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "integrations":
      return (
        <LazySection
          load={() => import("./sections/IntegrationsSection")}
          name="IntegrationsSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "mcp":
      return (
        <LazySection
          load={() => import("./sections/McpSection")}
          name="McpSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "sso":
      return (
        <LazySection
          load={() => import("./sections/SsoSection")}
          name="SsoSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "registry":
      return (
        <LazySection
          load={() => import("./sections/RegistrySection")}
          name="RegistrySection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
    case "about":
      return <AboutSection />;
  }
}

/// Minimal lazy loader: dynamic import with a spinner while the chunk lands.
function LazySection({
  load,
  name,
  detail,
  onDetailChange,
}: {
  load: () => Promise<{ default: React.ComponentType<SectionDetailProps> }>;
  name: string;
  detail: string | null;
  onDetailChange: (detail: string | null) => void;
}) {
  const [Comp, setComp] = useState<React.ComponentType<SectionDetailProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setComp(null);
    setError(null);
    load()
      .then((m) => !cancelled && setComp(() => m.default))
      .catch(() => !cancelled && setError(`failed to load the ${name} section`));
    return () => {
      cancelled = true;
    };
  }, [load, name]);
  if (error) return <p className="text-base text-destructive">{error}</p>;
  if (!Comp)
    return (
      <SkeletonForm />
    );
  return <Comp detail={detail} onDetailChange={onDetailChange} />;
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

