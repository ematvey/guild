// Onboarding guide: one dialog with a section list on the right and the
// selected topic on the left. The rail's Help/Learn button opens it (over
// the running UI), it lives at /onboard for deep links, and it auto-shows
// for users the server flags as not yet onboarded. Closing it from any
// section completes the server-side onboarding flag.

import { useState } from "react";
import { Bot, FolderKanban, KeyRound, MonitorSmartphone, MessagesSquare } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@guild/ui/components/dialog";

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
        shows up under Settings → Machine.
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
        Open <b>Settings → Gateway</b> and click <b>Create key</b>. Copy the
        key it gives you — it starts with <code>gk_</code> and is shown only
        once.
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
        When it needs to do something important, Guild asks you first. You
        decide how much it may do on its own in <b>Settings → Approvals</b>.
      </p>
      <p>
        Two handy extras: type <code>/</code> in the message box to use a{" "}
        <b>skill</b> (a ready-made recipe the assistant follows), and use the
        paperclip to attach files.
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
        Click <b>Work</b> in the left bar, then <b>New project</b>. Give it a
        name and a folder on one of your computers.
      </Step>
      <Step n={2}>
        Start chats inside the project — they automatically work with that
        folder, so you never have to explain where things are.
      </Step>
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
          the things people add later: an app for their own computer, a way to
          connect their other tools, and projects to keep work organized. You
          can skip all of it.
        </p>
      </div>
    ),
  },
  { id: "desktop", label: "Desktop app", icon: MonitorSmartphone, body: () => <DesktopSection /> },
  { id: "gateway", label: "Connect other tools", icon: KeyRound, body: () => <GatewaySection /> },
  { id: "chat", label: "Chatting", icon: MessagesSquare, body: () => <ChatSection /> },
  { id: "projects", label: "Projects", icon: FolderKanban, body: () => <ProjectsSection /> },
];

/** The guided tour — a big dialog floating over the running app: the
 *  selected section on the left, the section list on the right. */
export function OnboardingGuide({
  onDone,
}: {
  /** Closes the guide: completes onboarding, then navigates to `exit`. */
  onDone: (exit: OnboardingExit) => void;
}) {
  const [step, setStep] = useState(0);
  const section = SECTIONS[step]!;
  const last = step === SECTIONS.length - 1;
  const Icon = section.icon;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(null); }}>
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Guild guide</DialogTitle>
        <div className="grid sm:min-h-[26rem] sm:grid-cols-[1fr_13rem]">
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
              {step === 1 && (
                <Button variant="outline" onClick={() => onDone("device")}>
                  Set it up now
                </Button>
              )}
              {step === 2 && (
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
            {SECTIONS.map((s, i) => {
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
