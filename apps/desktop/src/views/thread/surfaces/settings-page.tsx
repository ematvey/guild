import { SettingsSectionPane } from "../../settings/settings-sections";

export function SettingsPage(props: { section: string; email: string; role: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
      <SettingsSectionPane sectionId={props.section} email={props.email} role={props.role} />
    </div>
  );
}
