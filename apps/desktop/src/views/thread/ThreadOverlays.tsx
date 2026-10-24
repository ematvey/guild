// The thread view's floating surfaces: the device-setup dialog, the
// onboarding guide and the create-project dialog.
import { apiOnboarded, machineId, type MachineInfo, type Project } from "../../transport";
import { DeviceSetupDialog } from "../device-setup";
import { OnboardingGuide, type OnboardingExit } from "../onboarding";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import type { RoutePatch } from "./route";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function ThreadOverlays({
  deviceOpen,
  onboardOpen,
  createProjectOpen,
  onCloseCreateProject,
  onProjectCreated,
  onboarded,
  onOnboarded,
  machines,
  projects,
  pushRoute,
}: {
  deviceOpen: boolean;
  onboardOpen: boolean;
  createProjectOpen: boolean;
  onCloseCreateProject: (open: boolean) => void;
  onProjectCreated: () => void;
  onboarded: boolean;
  onOnboarded?: () => void;
  machines: MachineInfo[] | null;
  projects: Project[] | null;
  pushRoute: (next: RoutePatch) => void;
}) {
  return (
    <>
      <DeviceSetupDialog
        open={deviceOpen}
        onOpenChange={(o) => {
          if (!o) pushRoute({ overlay: null });
        }}
      />

      {/* Onboarding guide: the rail's Help/Learn button opens it, it lives
          at /onboard (chat-independent route any user can open, /help deep
          links alias there), and it auto-shows for users the server flags as
          not yet onboarded — the auto-push makes the guide own the URL, so a
          reload lands back in it. It floats over the running UI; closing it
          from any section marks the server-side flag and returns to chats. */}
      {(onboardOpen || !onboarded) && (
        <OnboardingGuide
          onDone={(exit: OnboardingExit) => {
            void apiOnboarded();
            onOnboarded?.();
            if (exit === "device") {
              pushRoute({ chatId: null, projectId: null, skills: null, newChat: false, overlay: { kind: "device" } });
            } else if (exit === "gateway") {
              pushRoute({
                chatId: null,
                projectId: null,
                overlay: null,
                skills: null,
                tab: "settings",
                settingsSection: "gateway",
                settingsDetail: null,
                newChat: false,
              });
            } else {
              // Plain close (Got it, skip, Esc, ✕): /onboard itself always
              // renders the guide, so closing must leave the route.
              pushRoute({
                chatId: null,
                projectId: null,
                overlay: null,
                skills: null,
                tab: "chats",
                newChat: false,
              });
            }
          }}
        />
      )}

      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={onCloseCreateProject}
        machines={machines}
        localMachineId={machineId()}
        isTauri={isTauri}
        projects={projects}
        onCreated={onProjectCreated}
      />
    </>
  );
}
