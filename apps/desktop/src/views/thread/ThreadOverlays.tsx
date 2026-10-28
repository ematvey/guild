// The thread view's floating surfaces: the device-setup dialog, the
// onboarding guide, the "Add to Home Screen" guide and the create-project
// dialog.
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { apiOnboarded } from "../../lib/api/servers";
import { machineId } from "../../lib/machine-rpc";
import { IS_TAURI, installState, installSurface, type InstallState } from "../../lib/session";
import type { MachineInfo } from "../../lib/api/machines";
import type { Project } from "../../lib/api/projects";
import { DeviceSetupDialog } from "../device-setup";
import { InstallSteps, OnboardingGuide, type OnboardingExit } from "../onboarding";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import type { RoutePatch } from "./route";


/** The `/install` dialog: the address a help link or a colleague can share. */
function InstallGuide({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<InstallState>(() =>
    installState(installSurface()),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Guild to your Home Screen</DialogTitle>
          <DialogDescription>
            It opens like an app, without the browser bars, and it is the copy
            that can notify you later.
          </DialogDescription>
        </DialogHeader>
        <InstallSteps
          state={state}
          onRecheck={() => setState(installState(installSurface()))}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ThreadOverlays({
  deviceOpen,
  onboardOpen,
  installOpen,
  createProjectOpen,
  onCloseCreateProject,
  onboarded,
  onOnboarded,
  machines,
  projects,
  pushRoute,
}: {
  deviceOpen: boolean;
  onboardOpen: boolean;
  installOpen: boolean;
  createProjectOpen: boolean;
  onCloseCreateProject: (open: boolean) => void;
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

      <InstallGuide
        open={installOpen}
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
        isTauri={IS_TAURI}
        projects={projects}
      />
    </>
  );
}
