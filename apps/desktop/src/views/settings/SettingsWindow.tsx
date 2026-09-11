//! Guild settings window: one big dialog with its own sidebar and sections.
//! User sections for everyone; org sections appear for admins. Sections are
//! lazy-imported so the chat bundle only pays for what opens.

import { useEffect, useState } from "react";
import {
  Bot,
  Cpu,
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
import { X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@guild/ui/components/dialog";
import { apiMe } from "../../transport";
import { useTheme } from "../../theme";
import { MachineSection } from "./sections/MachineSection";
import { ApprovalsSection } from "./sections/ApprovalsSection";
import { AssistantSection } from "./sections/AssistantSection";

type SectionId =
  | "account"
  | "appearance"
  | "machine"
  | "approvals"
  | "usage"
  | "assistant"
  | "users"
  | "teams"
  | "models"
  | "integrations"
  | "sso"
  | "registry";
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
  chatId,
  currentMachineId,
  onMachineChanged,
  section,
  onSectionChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  role: string;
  chatId: string | null;
  currentMachineId: string | null;
  onMachineChanged: () => void;
  /** Active section, driven by the URL (/settings/<section>); null = default. */
  section: string | null;
  /** Section picks push a new URL so back/forward walk section history. */
  onSectionChange: (id: SectionId) => void;
}) {
  const isAdmin = role === "admin";
  const sections: SectionDef[] = [
    { id: "account", label: "Account", icon: <User className="size-4" />, group: "user" },
    { id: "appearance", label: "Appearance", icon: <Palette className="size-4" />, group: "user" },
    { id: "machine", label: "Machine", icon: <Cpu className="size-4" />, group: "user" },
    {
      id: "approvals",
      label: "Approvals",
      icon: <ShieldCheck className="size-4" />,
      group: "user",
    },
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
  ];
  const visible = sections.filter((s) => !s.admin || isAdmin);
  // Section is URL-driven (WebChat owns it); an unknown section (stale deep
  // link, or a role/chat change that hid it) falls back to the first visible.
  const activeDef = visible.find((s) => s.id === section) ?? visible[0];

  const groups: { key: "user" | "org"; label: string }[] = [
    { key: "user", label: "User" },
    ...(isAdmin ? [{ key: "org" as const, label: "Organization" }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-screen max-h-none w-screen max-w-none gap-0 rounded-none border-0 overflow-hidden p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">Guild settings</DialogDescription>
        {/* settings sidebar */}
        <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="flex items-center gap-2 px-4 py-4">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Bot className="size-4" />
            </div>
            <span className="min-w-0 flex-1 text-sm font-semibold">Settings</span>
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
                  <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {g.label}
                  </p>
                  {items.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onSectionChange(s.id)}
                      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors ${
                        activeDef?.id === s.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      {s.icon}
                      {s.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="border-t border-border/60 px-3 py-3">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {email.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{email}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {isAdmin ? "admin" : "member"}
                </p>
              </div>
            </div>
          </div>
        </nav>
        {/* section pane */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {activeDef && (
            <SectionPane
              def={activeDef}
              email={email}
              chatId={chatId}
              currentMachineId={currentMachineId}
              onMachineChanged={onMachineChanged}
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
  chatId,
  currentMachineId,
  onMachineChanged,
}: {
  def: SectionDef;
  email: string;
  chatId: string | null;
  currentMachineId: string | null;
  onMachineChanged: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="mb-7 text-base font-semibold">{def.label}</h2>
      <SectionBody
        id={def.id}
        email={email}
        chatId={chatId}
        currentMachineId={currentMachineId}
        onMachineChanged={onMachineChanged}
      />
    </div>
  );
}

function SectionBody({
  id,
  email,
  chatId,
  currentMachineId,
  onMachineChanged,
}: {
  id: SectionId;
  email: string;
  chatId: string | null;
  currentMachineId: string | null;
  onMachineChanged: () => void;
}) {
  switch (id) {
    case "account":
      return <AccountSection email={email} />;
    case "appearance":
      return <AppearanceSection />;
    case "machine":
      return (
        <MachineSection
          chatId={chatId}
          currentMachineId={currentMachineId}
          onMachineChanged={onMachineChanged}
        />
      );
    case "approvals":
      return <ApprovalsSection />;
    case "usage":
      return <LazySection load={() => import("./sections/UsageSection")} name="UsageSection" />;
    case "assistant":
      return <AssistantSection />;
    case "users":
      return <LazySection load={() => import("./sections/UsersSection")} name="UsersSection" />;
    case "teams":
      return <LazySection load={() => import("./sections/TeamsSection")} name="TeamsSection" />;
    case "models":
      return <LazySection load={() => import("./sections/ModelsSection")} name="ModelsSection" />;
    case "integrations":
      return <LazySection load={() => import("./sections/IntegrationsSection")} name="IntegrationsSection" />;
    case "sso":
      return <LazySection load={() => import("./sections/SsoSection")} name="SsoSection" />;
    case "registry":
      return <LazySection load={() => import("./sections/RegistrySection")} name="RegistrySection" />;
  }
}

/// Minimal lazy loader: dynamic import with a spinner while the chunk lands.
function LazySection({
  load,
  name,
}: {
  load: () => Promise<{ default: React.ComponentType }>;
  name: string;
}) {
  const [Comp, setComp] = useState<React.ComponentType | null>(null);
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
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!Comp)
    return (
      <div className="space-y-3 pt-2">
        <div className="h-4 w-40 animate-pulse rounded-md bg-accent" />
        <div className="h-24 w-full animate-pulse rounded-lg bg-accent" />
      </div>
    );
  return <Comp />;
}

function AccountSection({ email }: { email: string }) {
  const [role, setRole] = useState<string>("…");
  useEffect(() => {
    apiMe().then((u) => setRole(u?.role ?? "member"));
  }, []);
  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Email</p>
        <p className="mt-1 text-sm">{email}</p>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Role</p>
        <p className="mt-1 text-sm capitalize">{role}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {role === "admin"
            ? "You can configure the organization: users, models, integrations and registry."
            : "Ask an org admin for model or integration changes."}
        </p>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const options: { id: string; label: string; hint: string }[] = [
    { id: "light", label: "Light", hint: "Warm beige sidebar, white canvas" },
    { id: "dark", label: "Dark", hint: "Near-black canvas, warm sidebar" },
  ];
  return (
    <div className="space-y-3 pt-2">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => setTheme(o.id as "light" | "dark")}
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
  );
}

