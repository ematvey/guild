import { isControlSection } from "../settings/section-nav";
import { SETTINGS_SECTIONS } from "../settings/settings-sections";
import { CloseSidebarButton, CollapseButton } from "./chrome";
import { TOP_ROW, titleBarDragDeep } from "../../lib/titlebar";

export function SettingsPanel({
  role,
  inControl,
  onControlTab,
  activeSection,
  onSelectSection,
  onCollapse,
  onClose,
}: {
  /** "admin" turns on the workspace sections, same as the rail menu. */
  role: string;
  inControl: boolean;
  onControlTab: (tab: "agents" | "activity" | "integrations" | "skill-management") => void;
  /** The section rendered in the main pane (inline settings); null = none
   * picked yet. */
  activeSection: string | null;
  /** A section pick renders that section inline in the main pane. */
  onSelectSection: (id: string) => void;
  onCollapse?: () => void;
  /** Mobile drawer only: close the sheet from the panel header. */
  onClose?: () => void;
}) {
  const isAdmin = role === "admin";
  const visible = SETTINGS_SECTIONS.filter((s) => (!s.admin || isAdmin) && isControlSection(s.id) === inControl);
  const groups: { key: "user" | "workspace"; label: string }[] = [
    { key: "user", label: "User" },
    ...(isAdmin ? [{ key: "workspace" as const, label: "Workspace" }] : []),
  ];
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col text-base">
      <div {...titleBarDragDeep} className={`flex items-center justify-between px-3 ${TOP_ROW}`}>
        <span className="font-semibold">{inControl ? "Control Center" : "Settings"}</span>
        <span className="flex items-center gap-1">
          <CollapseButton onCollapse={onCollapse} />
          {onClose !== undefined && <CloseSidebarButton onClose={onClose} />}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {inControl && (
          <div className="space-y-0.5">
            <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent" onClick={() => onControlTab("agents")}>Agents</button>
            <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent" onClick={() => onControlTab("skill-management")}>Skills</button>
            {isAdmin && (
              <>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent" onClick={() => onControlTab("integrations")}>Integrations</button>
                <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent" onClick={() => onControlTab("activity")}>Activity</button>
              </>
            )}
          </div>
        )}
        {groups.map((g) => {
          const items = visible.filter((s) => s.group === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key}>
              <p className="px-1 pb-1 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
                {g.label}
              </p>
              <div className="space-y-0.5">
                {items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelectSection(s.id)}
                    className={`relative flex w-full items-center rounded-md px-2 py-1.5 text-left outline-none transition-colors ${
                      activeSection === s.id
                        ? "bg-sidebar-accent text-sidebar-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    }`}
                  >
                    {activeSection === s.id && (
                      <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-foreground/40" />
                    )}
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
