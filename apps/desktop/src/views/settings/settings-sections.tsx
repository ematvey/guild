import { useTheme } from "../../theme";
import { PageHeader } from "../../components/page-header";
import { FactCard, FactGrid } from "./components/fact-card";
import { MachineSection } from "./sections/MachineSection";
import { AboutSection } from "./sections/AboutSection";
import { NotificationsSection } from "./sections/NotificationsSection";

export function SettingsSectionPane({ sectionId, email, role }: { sectionId: string; email: string; role: string }) {
  const content = {
    account: <AccountSection email={email} role={role} />,
    appearance: <AppearanceSection />,
    notifications: <NotificationsSection />,
    machine: <MachineSection />,
    about: <AboutSection />,
  };
  const section = sectionId as keyof typeof content;
  return (
    <div className="mx-auto max-w-4xl px-4 pb-6 sm:px-8 sm:pb-8">
      {Object.hasOwn(content, section) ? content[section] : content.account}
    </div>
  );
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
