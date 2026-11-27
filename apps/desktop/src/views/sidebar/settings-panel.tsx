import { isControlSection } from "../settings/section-nav";
import { SETTINGS_SECTIONS } from "../settings/settings-catalog";

export function SettingsPanel({
  role,
  activeSection,
  onSelectSection,
}: {
  /** "admin" turns on the workspace sections, same as the rail menu. */
  role: string;
  /** The section rendered in the main pane (inline settings); null = none
   * picked yet. */
  activeSection: string | null;
  /** A section pick renders that section inline in the main pane. */
  onSelectSection: (id: string) => void;
}) {
  const isAdmin = role === "admin";
  const visible = SETTINGS_SECTIONS.filter((s) => (!s.admin || isAdmin) && (s.id === "gateway" || !isControlSection(s.id)));
  return (
    <nav aria-label="Settings sections" className="min-h-0 w-full flex-1 space-y-0.5 overflow-y-auto p-2 text-base">
      {visible.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => onSelectSection(section.id)}
          aria-current={activeSection === section.id ? "page" : undefined}
          className={`guild-sidebar-current flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-ring ${
            activeSection === section.id
              ? "bg-sidebar-accent text-sidebar-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          }`}
        >
          {section.icon}
          {section.label}
        </button>
      ))}
    </nav>
  );
}
