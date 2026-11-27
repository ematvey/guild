import { Button } from "@guild/ui/components/button";
import { useTheme, useWorkAppearance, workFonts, workPalettes, type Theme } from "../../theme";
import { PageHeader } from "../../components/page-header";
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
    <div className="px-4 py-3 sm:px-5">
      {Object.hasOwn(content, section) ? content[section] : content.account}
    </div>
  );
}

function AccountSection({ email, role }: { email: string; role: string }) {
  return (
    <div className="space-y-5">
      <PageHeader inlineActions title="Account" description="Your sign-in and role in this workspace." />
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="min-w-0 break-all">{email}</dd>
        </div>
        <div className="flex justify-between gap-4 py-2.5">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="capitalize">{role}</dd>
        </div>
      </dl>
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
        inlineActions
        title="Appearance"
        description="Customize how Guild looks on this device."
      />
      <section className="space-y-2 border-b border-border pb-4">
        <h2 className="font-semibold">Color mode</h2>
        <div role="group" aria-label="Color mode" className="grid grid-cols-3 gap-2">
          {modes.map(({ id, label }) => (
            <Button
              key={id}
              variant="outline"
              className={theme === id ? "border-primary bg-accent text-primary" : undefined}
              aria-pressed={theme === id}
              onClick={() => setTheme(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </section>
      <section className="space-y-2 border-b border-border pb-4">
        <h2 className="font-semibold">Color palette</h2>
        <div role="group" aria-label="Color palette" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
        </div>
      </section>
      <section className="space-y-2 border-b border-border pb-4">
        <h2 className="font-semibold">Typeface</h2>
        <div role="group" aria-label="Typeface" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {workFonts.map((font) => (
            <Button
              key={font}
              variant="outline"
              className={appearance.font === font ? "border-primary bg-accent text-primary" : undefined}
              aria-pressed={appearance.font === font}
              onClick={() => setAppearance({ font })}
            >
              {font === "System" ? "System UI" : font}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}
