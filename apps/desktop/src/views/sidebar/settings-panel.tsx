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
  const visible = SETTINGS_SECTIONS.filter((s) => (!s.admin || isAdmin) && !isControlSection(s.id));
  const groups: { key: "user" | "workspace"; label: string }[] = [{ key: "user", label: "User" }];
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col text-base">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => {
          const items = visible.filter((s) => s.group === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <p className="px-1 pb-1 pt-4 text-base font-medium uppercase tracking-wider text-muted-foreground/60">
                {g.label}
              </p>
              <div className="space-y-0.5">
                {items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelectSection(s.id)}
                    aria-current={activeSection === s.id ? "page" : undefined}
                    className={`guild-sidebar-current relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors ${
                      activeSection === s.id
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    }`}
                  >
                    {activeSection === s.id && (
                      <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-primary/60" />
                    )}
                    {s.icon}
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
