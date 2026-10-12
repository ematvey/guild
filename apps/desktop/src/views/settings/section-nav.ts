/// Props sections accept when their sub-pages are URL-addressed
/// (/settings/<section>/<detail>): the open sub-page id (null = list page)
/// and the navigation callback that pushes the new URL.
export interface SectionDetailProps {
  detail?: string | null;
  onDetailChange: (detail: string | null) => void;
}

/** Static id/label list of the settings sections; ids match
 * SettingsWindow's SectionId union and drive the sidebar rail's Settings
 * tab. `admin` rows appear only for admins. */
export interface SettingsSectionRef {
  id: string;
  label: string;
  admin?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionRef[] = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "machine", label: "Machine" },
  { id: "gateway", label: "Gateway" },
  { id: "skills", label: "Skills" },
  { id: "approvals", label: "Approvals" },
  { id: "general", label: "General", admin: true },
  { id: "usage", label: "Usage", admin: true },
  { id: "assistant", label: "Assistant", admin: true },
  { id: "users", label: "Users", admin: true },
  { id: "teams", label: "Teams", admin: true },
  { id: "models", label: "Models", admin: true },
  { id: "integrations", label: "Integrations", admin: true },
  { id: "sso", label: "Sign-in / SSO", admin: true },
  { id: "registry", label: "Registry", admin: true },
  { id: "about", label: "About" },
];
