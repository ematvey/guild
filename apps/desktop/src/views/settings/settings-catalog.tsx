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
  ShieldCheck,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { isAdminSection, type SettingsSectionId as SectionId } from "./section-nav";

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
    { id: "machine", label: "Devices", icon: <Cpu className="size-4" />, group: "user" },
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
    { id: "security", label: "Security", icon: <ShieldCheck className="size-4" />, group: "workspace" },
    { id: "registry", label: "Registry", icon: <Layers className="size-4" />, group: "workspace" },
  ] satisfies Omit<SectionDef, "admin">[]
).map((s) => ({ ...s, admin: isAdminSection(s.id) }));
