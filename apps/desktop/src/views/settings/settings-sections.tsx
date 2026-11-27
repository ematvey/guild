import { Button } from "@guild/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";
import { useTheme, useWorkAppearance, workFonts, workPalettes, type Theme } from "../../theme";
import { PageHeader } from "../../components/page-header";
import { FactCard, FactGrid } from "./components/fact-card";
import { GatewaySection } from "./sections/GatewaySection";
import { MachineSection } from "./sections/MachineSection";
import { AboutSection } from "./sections/AboutSection";
import { NotificationsSection } from "./sections/NotificationsSection";

export function SettingsSectionPane({
  sectionId,
  email,
  role,
  onSetupDevice,
}: {
  sectionId: string;
  email: string;
  role: string;
  onSetupDevice?: () => void;
}) {
  const content = {
    account: <AccountSection email={email} role={role} />,
    appearance: <AppearanceSection />,
    notifications: <NotificationsSection />,
    gateway: <GatewaySection />,
    machine: <MachineSection onSetupDevice={onSetupDevice} />,
    about: <AboutSection />,
  };
  const section = sectionId as keyof typeof content;
  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-8 sm:py-8">
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
  const { appearance, setAppearance } = useWorkAppearance();
  const modes: { id: Theme; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    { id: "system", label: "System" },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Appearance"
        description="Customize how Guild looks on this device."
      />
      <Card>
        <CardHeader>
          <CardTitle>Color mode</CardTitle>
        </CardHeader>
        <CardContent role="group" aria-label="Color mode" className="grid grid-cols-3 gap-2">
          {modes.map(({ id, label }) => (
            <Button
              key={id}
              variant={theme === id ? "secondary" : "outline"}
              aria-pressed={theme === id}
              onClick={() => setTheme(id)}
            >
              {label}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Color palette</CardTitle>
        </CardHeader>
        <CardContent role="group" aria-label="Color palette" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {workPalettes.map((palette) => (
            <Button
              key={palette}
              variant="outline"
              className={appearance.palette === palette ? "border-primary bg-accent text-primary" : undefined}
              aria-pressed={appearance.palette === palette}
              onClick={() => setAppearance({ palette })}
            >
              <span data-palette-swatch={palette} className="size-3 rounded-full" aria-hidden="true" />
              {palette}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Typeface</CardTitle>
        </CardHeader>
        <CardContent role="group" aria-label="Typeface" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {workFonts.map((font) => (
            <Button
              key={font}
              variant={appearance.font === font ? "secondary" : "outline"}
              aria-pressed={appearance.font === font}
              onClick={() => setAppearance({ font })}
            >
              {font === "System" ? "System UI" : font}
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
