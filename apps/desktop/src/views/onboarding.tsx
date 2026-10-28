// Onboarding guide: one dialog with a section list on the right and the
// selected topic on the left. The rail's Help/Learn button opens it (over
// the running UI), it lives at /onboard for deep links, and it auto-shows
// for users the server flags as not yet onboarded. Closing it from any
// section completes the server-side onboarding flag.
//
// The same file owns the "Add to Home Screen" steps: they are onboarding
// too, they render in the /install dialog and on the login card, and they
// share one state model with the guide's "On your phone" section.

import { useState } from "react";
import { Bell, Bot, Check, FolderKanban, KeyRound, MessagesSquare, MonitorSmartphone, Package, Plus, Share, Smartphone, X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@guild/ui/components/dialog";
import {
  installOffered,
  installState,
  installSurface,
  type InstallState,
} from "../lib/session";

/** Where the guide should land the user when it closes; null = the plain
 *  close (Done, skip, Esc, ✕). WebChat completes onboarding and pushes the
 *  matching route. */
export type OnboardingExit = "device" | "gateway" | null;

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <p>
      <span className="mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
        {n}
      </span>
      {children}
    </p>
  );
}

function InstallStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** The steps for one install state, plus the honest limit of each case.
 *  Rendered by the /install dialog, the login card and this guide. */
export function InstallSteps({
  state,
  onRecheck,
  large = false,
}: {
  state: InstallState;
  onRecheck?: () => void;
  /** Full-screen sheet: one step larger, so the steps read at arm's length. */
  large?: boolean;
}) {
  const text = large ? "text-base" : "text-sm";
  if (state === "installed") {
    return (
      <div className={`space-y-3 text-muted-foreground ${text}`}>
        <p className="flex items-start gap-2.5 text-foreground">
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          Guild is installed on this device.
        </p>
        <p className="flex items-start gap-2.5">
          <Bell className="mt-0.5 size-4 shrink-0" />
          Notifications reach this copy only. If you delete the icon, they
          stop.
        </p>
      </div>
    );
  }

  if (state === "other") {
    return (
      <p className={`text-muted-foreground ${text}`}>
        This page already runs as an app in your browser. The Home Screen
        install is for iPhone and iPad. On a Mac, Safari's File → Add to Dock
        does the same job.
      </p>
    );
  }

  if (state === "ios-browser") {
    return (
      <div className={`space-y-3 text-muted-foreground ${text}`}>
        <p className="flex items-start gap-2.5 text-foreground">
          <Smartphone className="mt-0.5 size-4 shrink-0" />
          This browser cannot install Guild, and its copy cannot receive
          notifications.
        </p>
        <p>
          Open this address in <b>Safari</b>, then follow the steps there.
        </p>
        {onRecheck && (
          <Button variant="outline" size="sm" onClick={onRecheck}>
            Check again
          </Button>
        )}
      </div>
    );
  }

  if (state === "android") {
    return (
      <div className={`space-y-3 text-muted-foreground ${text}`}>
        <ol className="space-y-2.5">
          <InstallStep n={1}>
            Tap the browser menu — the three dots in the top corner.
          </InstallStep>
          <InstallStep n={2}>
            Tap <b>Install app</b> (older versions say{" "}
            <b>Add to Home screen</b>).
          </InstallStep>
          <InstallStep n={3}>
            Confirm, then open Guild from the new icon.
          </InstallStep>
        </ol>
        <p className="flex items-start gap-2.5 border-t border-border pt-3">
          <Bell className="mt-0.5 size-4 shrink-0" />
          Only the installed copy can receive notifications.
        </p>
        {onRecheck && (
          <Button variant="outline" size="sm" onClick={onRecheck}>
            I did it — check again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-3 text-muted-foreground ${text}`}>
      <ol className="space-y-2.5">
        <InstallStep n={1}>
          Tap the <Share className="inline size-4 align-text-bottom" />{" "}
          <b>Share</b> button in the toolbar. It is the square with an arrow
          pointing up.
        </InstallStep>
        <InstallStep n={2}>
          Scroll the list and tap{" "}
          <b>
            <Plus className="inline size-4 align-text-bottom" /> Add to Home
            Screen
          </b>
          .
        </InstallStep>
        <InstallStep n={3}>
          Tap <b>Add</b>, then open Guild from the new icon on your Home
          Screen.
        </InstallStep>
      </ol>
      <p className="flex items-start gap-2.5 border-t border-border pt-3">
        <Bell className="mt-0.5 size-4 shrink-0" />
        Only the installed copy can receive notifications. A tab in Safari
        cannot.
      </p>
      {onRecheck && (
        <Button variant="outline" size="sm" onClick={onRecheck}>
          I did it — check again
        </Button>
      )}
    </div>
  );
}

/** The full-screen install offer: a phone that is not installed gets the
 *  steps on their own screen, at reading size, with one large action. */
function InstallSheet({
  state,
  onDismiss,
}: {
  state: InstallState;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-7 overflow-y-auto py-6">
          <div className="space-y-3">
            <Smartphone className="size-12 text-muted-foreground" />
            <h1 className="text-2xl font-semibold leading-tight">Install Guild</h1>
            <p className="text-base text-muted-foreground">
              It opens full screen, without browser bars, and it is the copy
              that can notify you.
            </p>
          </div>
          <InstallSteps state={state} large />
        </div>
        <div className="shrink-0 pt-2">
          <Button className="h-12 w-full text-base" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The floating prompt: one line on any screen, the steps behind it,
 *  dismissible. A phone that is not installed always gets it, signed in or
 *  not; an installed copy and a desktop browser get nothing. The wide-screen
 *  card sits bottom-right, the same corner the update toast uses. */
export function InstallPrompt() {
  const [surface] = useState(installSurface);
  // Dismissal lasts until the next page load: the offer returns every time
  // the app is opened, so a phone cannot lose it by tapping once.
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  if (dismissed) return null;
  const state = installState(surface);
  const close = () => setDismissed(true);
  // A phone gets the whole screen, before or after sign-in: the steps are
  // the first thing the app asks for, and a corner card is too easy to
  // scroll past. A browser we cannot name still gets the menu steps.
  if (isMobile) {
    if (state === "installed") return null;
    return (
      <InstallSheet
        state={state === "other" ? "android" : state}
        onDismiss={close}
      />
    );
  }
  if (!installOffered(surface)) return null;
  return (
    <div className="fixed inset-x-3 top-3 z-50 rounded-lg border border-border bg-card p-3 text-xs shadow-lg sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-auto sm:w-80">
      <div className="flex items-start gap-2">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <button
            className="text-left font-medium text-foreground outline-none hover:underline"
            onClick={() => setOpen((o) => !o)}
          >
            Add Guild to your Home Screen
          </button>
          <p className="mt-0.5 text-muted-foreground">
            It opens without the browser bars, and it is the copy that can
            notify you.
          </p>
          {open && (
            <div className="mt-2.5">
              <InstallSteps state={state} />
            </div>
          )}
        </div>
        <button
          aria-label="Dismiss"
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground"
          onClick={close}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function DesktopSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        The website version runs safely in the cloud — it talks to you but
        can't touch your own files. The desktop app lives on your computer, so
        an assistant there can work with your things directly: open your
        folders, edit documents, run tasks for you.
      </p>
      <Step n={1}>
        Click the round avatar at the very bottom of the left bar and choose{" "}
        <b>Set up a device</b>.
      </Step>
      <Step n={2}>
        Download the app for your computer (Mac, Windows or Linux) and install
        it like any normal app.
      </Step>
      <Step n={3}>
        Open the app on your computer and enter the one-time code from that
        same dialog — that links it to your account. After that, your computer
        shows up under Settings → Machines.
      </Step>
    </div>
  );
}

function GatewaySection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        A gateway key is like a password that lets another app or script use
        Guild's AI. You only need this if you want to connect something of
        yours to Guild — normal chatting never needs a key.
      </p>
      <Step n={1}>
        Open <b>Settings → Gateway</b> and click <b>New API key</b>. Copy
        the key it gives you — it starts with <code>gk_</code> and is shown
        only once.
      </Step>
      <Step n={2}>
        The same page shows the exact address and ready-made examples to paste
        into the app you're connecting. Follow those.
      </Step>
      <p>
        Lost a key or done with it? You can delete it any time on the same
        page and make a new one.
      </p>
    </div>
  );
}

function ChatSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Click <b>Chats</b> in the left bar, type what you want in your own
        words, and press send — like texting, but the assistant can actually
        do things for you, not just talk.
      </p>
      <p>
        When it needs to do something important — edit files, run commands —
        Guild checks with you first. How much it may do on its own is set per
        chat, with the approval button next to the message box (it shows
        the chat's current mode):
      </p>
      <Step n={1}>
        <b>Ask for approval</b> — Guild asks you before anything potentially
        unsafe. Safest choice.
      </Step>
      <Step n={2}>
        <b>Approve for me</b> — a separate AI checks each action for you and
        only stops the risky ones.
      </Step>
      <Step n={3}>
        <b>Full access</b> — the assistant acts on its own, within your
        organization's rules.
      </Step>
      <p>
        The setting applies to that chat only. A chat you never set follows
        your organization's default policy.
      </p>
      <p>
        Two handy extras: type <code>/</code> in the message box for{" "}
        <b>skills</b> and built-in <b>commands</b> (see the Skills topic), and
        click the <b>+</b> button next to the message box to attach images,
        audio, or other files.
      </p>
    </div>
  );
}

function SkillsSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        A skill is a ready-made recipe the assistant follows — for a report
        format, a coding task, any routine you repeat. Instead of explaining
        it every time, you type <code>/</code> in the message box and pick
        the skill.
      </p>
      <Step n={1}>
        Click <b>Skills</b> in the left bar. The <b>Catalog</b> tab lists
        skills shared across your organization — open one to see what it
        does, then install it for your own chats.
      </Step>
      <Step n={2}>
        Use <code>/</code> in any chat to run an installed skill.
      </Step>
      <p>
        On the desktop app you can also write your own skills (the{" "}
        <b>On this machine</b> tab) and publish them to the Catalog for
        everyone.
      </p>
    </div>
  );
}

function ProjectsSection() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        A project is a home for one piece of work — say, a report, a website,
        or a big research job. It keeps related chats together and gives the
        assistant one place to keep its files.
      </p>
      <Step n={1}>
        Click <b>Projects</b> in the left bar, then <b>New project</b>. Give
        it a name and a folder on one of your computers.
      </Step>
      <Step n={2}>
        Start chats inside the project — they automatically work with that
        folder, so you never have to explain where things are.
      </Step>
      <p>
        Project chats work like any other chat — including the approval
        setting next to the message box, explained in the <b>Chatting</b>
        topic.
      </p>
    </div>
  );
}

function InstallSection() {
  const [state, setState] = useState(() => installState(installSurface()));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        On a phone or tablet, Guild works best from a Home Screen icon: it
        opens without the browser bars, and that copy is the one that can
        notify you later.
      </p>
      <InstallSteps
        state={state}
        onRecheck={() => setState(installState(installSurface()))}
      />
    </div>
  );
}

const SECTIONS: {
  id: string;
  label: string;
  icon: typeof Bot;
  body: () => React.ReactNode;
}[] = [
  {
    id: "welcome",
    label: "Welcome",
    icon: Bot,
    body: () => (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Guild is your private AI workspace. You chat with assistants here,
          and they don't just talk — they do the work.
        </p>
        <p>
          You're already set up to chat. Pick any topic on the right to learn
          the things people add later: an app for their own computer, a way
          to connect their other tools, ready-made skills, and projects to
          keep work organized. You can skip all of it.
        </p>
      </div>
    ),
  },
  { id: "desktop", label: "Desktop app", icon: MonitorSmartphone, body: () => <DesktopSection /> },
  { id: "gateway", label: "Connect other tools", icon: KeyRound, body: () => <GatewaySection /> },
  { id: "chat", label: "Chatting", icon: MessagesSquare, body: () => <ChatSection /> },
  { id: "skills", label: "Skills", icon: Package, body: () => <SkillsSection /> },
  { id: "projects", label: "Projects", icon: FolderKanban, body: () => <ProjectsSection /> },
];

/** The sections this device can use: the Home Screen steps exist only where
 *  an install is possible and still missing. */
function sectionsForThisDevice(): typeof SECTIONS {
  if (!installOffered(installSurface())) return SECTIONS;
  return [
    ...SECTIONS,
    {
      id: "install",
      label: "On your phone",
      icon: Smartphone,
      body: () => <InstallSection />,
    },
  ];
}

/** The guided tour — a big dialog floating over the running app: the
 *  selected section on the left, the section list on the right. */
export function OnboardingGuide({
  onDone,
}: {
  /** Closes the guide: completes onboarding, then navigates to `exit`. */
  onDone: (exit: OnboardingExit) => void;
}) {
  const [step, setStep] = useState(0);
  const [sections] = useState(sectionsForThisDevice);
  const section = sections[step]!;
  const last = step === sections.length - 1;
  const Icon = section.icon;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(null); }}>
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Guild guide</DialogTitle>
        <div className="grid grid-cols-1 sm:min-h-[26rem] sm:grid-cols-[minmax(0,1fr)_13rem]">
          {/* selected section */}
          <div className="flex flex-col p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                <Icon className="size-5 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold">{section.label}</h2>
            </div>
            <div className="flex-1">{section.body()}</div>
            <div className="mt-6 flex items-center justify-end gap-2">
              {section.id === "desktop" && (
                <Button variant="outline" onClick={() => onDone("device")}>
                  Set it up now
                </Button>
              )}
              {section.id === "gateway" && (
                <Button variant="outline" onClick={() => onDone("gateway")}>
                  Create a key
                </Button>
              )}
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              )}
              {last ? (
                <Button onClick={() => onDone(null)}>Got it</Button>
              ) : (
                <Button onClick={() => setStep(step + 1)}>Next</Button>
              )}
            </div>
          </div>
          {/* section list */}
          <div className="flex flex-row gap-1 overflow-x-auto border-t border-border bg-muted/40 p-2 sm:flex-col sm:overflow-visible sm:border-l sm:border-t-0 sm:p-3">
            {sections.map((s, i) => {
              const SIcon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStep(i)}
                  aria-current={step === i}
                  className={`flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors ${
                    step === i
                      ? "bg-card font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <SIcon className="size-4 shrink-0" />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
