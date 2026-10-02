//! Guild settings window: one big dialog with its own sidebar and sections.
//! User sections for everyone; org sections appear for admins. Sections are
//! lazy-imported so the chat bundle only pays for what opens.

import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Building2,
  Cpu,
  Info,
  KeyRound,
  Layers,
  Palette,
  Plug,
  Puzzle,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@guild/ui/components/dialog";
import { apiMe } from "../../transport";
import {
  DropdownMenuItem,
} from "@guild/ui/components/dropdown-menu";
import { UserBadge } from "../../components/user-badge";
import { WorkspaceMenuItems } from "../workspace-menu";
import type { SectionDetailProps } from "./section-nav";
import { useTheme } from "../../theme";
import { PageHeader } from "./components/page-header";
import { FactCard, FactGrid } from "./components/fact-card";
import {
  clampSidebarWidth,
  saveSidebarWidth,
  storedSidebarWidth,
} from "../../lib/sidebar-width";
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
  | "sso"
  | "registry"
  | "skills"
  | "about";
  // No "releases" pane: desktop releases are dev-controlled, not
  // admin-controlled.

interface SectionDef {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
  group: "user" | "org";
  admin?: boolean;
}

export function SettingsWindow({
  open,
  onOpenChange,
  email,
  role,
  displayName,
  avatarUrl,
  onOpenDevice,
  onAddWorkspace,
  section,
  detail,
  onSectionChange,
  onDetailChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  role: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Opens the device-setup dialog (replaces this overlay). */
  onOpenDevice: () => void;
  /** Desktop multi-workspace: opens the add-workspace card. */
  onAddWorkspace?: () => void;
  /** Active section, driven by the URL (/settings/<section>); null = default. */
  section: string | null;
  /** Sub-page inside the section (/settings/<section>/<detail>); null = list. */
  detail: string | null;
  /** Section picks push a new URL so back/forward walk section history. */
  onSectionChange: (id: SectionId) => void;
  /** Sub-page navigation: an id opens that detail page, null returns to the list. */
  onDetailChange: (detail: string | null) => void;
}) {
  const isAdmin = role === "admin";
  const sections: SectionDef[] = [
    { id: "account", label: "Account", icon: <User className="size-4" />, group: "user" },
    { id: "appearance", label: "Appearance", icon: <Palette className="size-4" />, group: "user" },
    { id: "machine", label: "Machine", icon: <Cpu className="size-4" />, group: "user" },
    { id: "gateway", label: "Gateway", icon: <KeyRound className="size-4" />, group: "user" },
    { id: "skills", label: "Skills", icon: <Puzzle className="size-4" />, group: "user" },
    {
      id: "approvals",
      label: "Approvals",
      icon: <ShieldCheck className="size-4" />,
      group: "user",
    },
    { id: "general", label: "General", icon: <Building2 className="size-4" />, group: "org", admin: true },
    { id: "usage", label: "Usage", icon: <Sparkles className="size-4" />, group: "org", admin: true },
    { id: "assistant", label: "Assistant", icon: <Bot className="size-4" />, group: "org", admin: true },
    { id: "users", label: "Users", icon: <Users className="size-4" />, group: "org", admin: true },
    { id: "teams", label: "Teams", icon: <UsersRound className="size-4" />, group: "org", admin: true },
    { id: "models", label: "Models", icon: <Waypoints className="size-4" />, group: "org", admin: true },
    {
      id: "integrations",
      label: "Integrations",
      icon: <Plug className="size-4" />,
      group: "org",
      admin: true,
    },
    { id: "sso", label: "Sign-in / SSO", icon: <KeyRound className="size-4" />, group: "org", admin: true },
    { id: "registry", label: "Registry", icon: <Layers className="size-4" />, group: "org", admin: true },
    { id: "about", label: "About", icon: <Info className="size-4" />, group: "user" },
  ];
  const visible = sections.filter((s) => !s.admin || isAdmin);
  // Section is URL-driven (WebChat owns it); an unknown section (stale deep
  // link, or a role/chat change that hid it) falls back to the first visible.
  const activeDef = visible.find((s) => s.id === section) ?? visible[0];

  const groups: { key: "user" | "org"; label: string }[] = [
    { key: "user", label: "User" },
    ...(isAdmin ? [{ key: "org" as const, label: "Workspace" }] : []),
  ];

  // same resizable sidebar as the chat, sharing its stored width
  const [width, setWidth] = useState(storedSidebarWidth);
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const move = (ev: MouseEvent) => setWidth(clampSidebarWidth(startW + ev.clientX - startX));
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setWidth((w) => {
          saveSidebarWidth(w);
          return w;
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [width],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-screen max-h-none w-screen max-w-none gap-0 rounded-none border-0 overflow-hidden p-0 sm:max-w-none"
        hideClose
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Guild settings</DialogDescription>
        {/* settings sidebar: same width as the chat sidebar, drag to resize */}
        <nav
          className="relative flex shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-150"
          style={{ width }}
        >
          <div className="flex items-center gap-2 px-4 py-4">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Bot className="size-4" />
            </div>
            <span className="min-w-0 flex-1 text-base font-semibold">Settings</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
              title="Close and go back to chat"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {groups.map((g) => {
              const items = visible.filter((s) => s.group === g.key);
              if (items.length === 0) return null;
              return (
                <div key={g.key} className="mb-3">
                  <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {g.label}
                  </p>
                  {items.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onSectionChange(s.id)}
                      className={`relative mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors ${
                        activeDef?.id === s.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      {activeDef?.id === s.id && (
                        <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-foreground/40" />
                      )}
                      {s.icon}
                      {s.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="border-t border-border/60 p-2">
            {/* same account menu as the chat sidebar */}
            <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl}>
              <WorkspaceMenuItems
                onAddWorkspace={onAddWorkspace}
                onReload={() => window.location.reload()}
              />
              <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>
            </UserBadge>
          </div>
          <div
            className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring"
            onMouseDown={startDrag}
            title="Drag to resize"
          />
        </nav>
        {/* section pane */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {activeDef && (
            <SectionPane
              def={activeDef}
              email={email}
              detail={detail}
              onDetailChange={onDetailChange}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
    <div className="mx-auto max-w-4xl px-8 py-8">
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
    case "gateway":
      return <GatewaySection />;
    case "approvals":
      return <ApprovalsSection />;
    case "skills":
      return (
        <LazySection
          load={() => import("./sections/SkillsSection")}
          name="SkillsSection"
          detail={detail}
          onDetailChange={onDetailChange}
        />
      );
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
      <div className="space-y-3 pt-2">
        <div className="h-4 w-40 animate-pulse rounded-md bg-accent" />
        <div className="h-24 w-full animate-pulse rounded-lg bg-accent" />
      </div>
    );
  return <Comp detail={detail} onDetailChange={onDetailChange} />;
}

function AccountSection({ email }: { email: string }) {
  const [role, setRole] = useState<string>("…");
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
          <p className="text-sm capitalize">{role}</p>
        </FactCard>
      </FactGrid>
      <p className="text-sm text-muted-foreground">
        {role === "admin"
          ? "You can configure the workspace: users, teams, models, integrations and registry."
          : "Ask a workspace admin for model or integration changes."}
      </p>
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

