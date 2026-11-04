// The composer that floats over the transcript: a read-only notice, a
// loading placeholder, or the editable card — queued chips, retryable sends,
// attachments, the mention picker, the prompt, and the action row (attach,
// project chip, approval mode, context ring, agent chip, send / stop).
import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownRight,
  FolderOpen,
  Loader2,
  Plus,
  ShieldCheck,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Textarea } from "@guild/ui/components/textarea";
import { Skeleton } from "@guild/ui/components/skeleton";
import { ContextRing } from "../../components/context-ring";
import { FadeTitle } from "../sidebar/chrome";
import { projectChipLabel, type PickedProject } from "../projects/projects";
import type { ChatApprovalMode } from "../../lib/api/approvals";
import type { OutgoingCommand } from "../../lib/outgoing-command";
import type { RenderBlock } from "../../lib/thread-reducer";
import { useMachines } from "../../lib/machines-store";
import type { Agent } from "../agents/agents-api";
import { AttachmentImageThumb, AttachmentFileChip } from "./attachments";
import { APPROVAL_MODES } from "./approval";
import { remoteMachine, sendButtonState, type ThreadFacts } from "./status";
import { isImeEnter } from "./route";
import { chatsStore, projectsStore } from "./chat-stores";
import type { ComposerHandle } from "./hooks/use-composer";
import type { AgentPick } from "./hooks/use-agent-pick";

/** Why the composer is read-only for this thread. */
function readOnlyNotice(facts: ThreadFacts, foreign: boolean, deletingAgent: Agent | null): string {
  if (facts.type === "user" && foreign) {
    return "Read-only. This thread belongs to another member; only its owner can send messages or change it.";
  }
  if (facts.deleted) return "Deleted. This thread is out of your lists and its runs have stopped.";
  if (facts.type === "user" && deletingAgent !== null) {
    return `Read-only. ${deletingAgent.name} is being deleted; restoring the agent makes this thread writable again.`;
  }
  if (facts.type === "routine") return "Routine run. Read-only — the agent wrote this transcript on a schedule.";
  if (facts.type === "subagent") return "Subagent thread. Read-only — the parent agent drives this conversation.";
  return "Archived. Unarchive this thread to send a message.";
}

/** One read-only chip for project + machine. The composer never binds
 *  projects: a chat is projectless unless it was started from a project
 *  (the sidebar project row's "+", which pre-picks the binding). The
 *  executing machine is project-derived: an existing chat inherits its bound
 *  project's machine, a new chat the picked project's. The dot renders only
 *  for a remote machine (on desktop the local machine executes its own
 *  tools) whose live socket state is known in the machines store. */
function ProjectChip({
  chatId,
  project,
  localMachineId,
}: {
  chatId: string | null;
  project: PickedProject | null;
  localMachineId: string | undefined;
}) {
  const chats = chatsStore.use();
  const projects = projectsStore.use();
  const machines = useMachines();
  if (!project) return null;
  const row = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  const bound = !!(row?.machine_id && row.project_id);
  // The chat row may be absent right after a create (route pushed before
  // the list lands) — the chip then renders without a live socket state.
  const remote = remoteMachine({
    machineId: bound ? row?.machine_id : projects?.find((p) => p.id === project.id)?.machine_id,
    rowLabel: bound ? row?.machine_label : undefined,
    machines,
    localMachineId,
  });
  const machineOnline = remote?.online;
  const showMachine = remote !== null && machineOnline !== undefined;
  return (
    <span
      className="flex h-8 max-w-52 items-center gap-1.5 rounded-full bg-secondary px-2 text-muted-foreground pointer-coarse:h-10"
      title={
        showMachine
          ? `${project.name} — Machine: ${remote?.label}${machineOnline ? " (online)" : " (offline)"}`
          : `${project.name} — ${project.machine_label ?? "project"}`
      }
    >
      {showMachine && (
        <span
          className={`size-2 shrink-0 rounded-full ${machineOnline ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
        />
      )}
      <span className="flex min-w-0 items-center gap-1 px-2">
        <FolderOpen className="size-4 shrink-0" />
        <span className="hidden min-w-0 sm:block sm:flex-1">
          <FadeTitle text={projectChipLabel(project)} />
        </span>
      </span>
    </span>
  );
}

/** The agent chip: a locked thread names its agent; otherwise a picker. */
function AgentChip({ agent, onManageAgents }: { agent: AgentPick; onManageAgents: () => void }) {
  const { agentLocked, shownAgent, personalAgent, agentsList, pickedAgent, pickAgent } = agent;
  if (agentLocked) {
    // An agent thread, or a chat whose thread belongs to a shared agent,
    // names its agent and keeps it.
    return (
      <span
        className="flex h-8 min-w-0 items-center gap-1 rounded-md bg-secondary px-2 text-xs text-secondary-foreground pointer-coarse:h-10"
        title={
          shownAgent?.visibility === "private"
            ? "Your private agent"
            : "Shared agent: your threads are private, its files are shared"
        }
      >
        <span className="truncate">{shownAgent?.name ?? "Assistant"}</span>
        {shownAgent !== null && shownAgent.visibility !== "private" && (
          <Users className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        )}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 items-center gap-1 rounded-md bg-secondary px-2 text-xs text-secondary-foreground pointer-coarse:h-10"
          title="Choose the agent for this chat"
        >
          <span className="truncate">{shownAgent?.name ?? personalAgent?.name ?? "Assistant"}</span>
          {shownAgent !== null && shownAgent.visibility !== "private" && (
            <Users className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          )}
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Agent</DropdownMenuLabel>
        {(agentsList ?? []).map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => pickAgent(a)}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{a.name}</span>
                {a.visibility !== "private" && <Users className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />}
              </span>
              {a.description ? (
                <span className="line-clamp-1 text-3xs text-muted-foreground">{a.description}</span>
              ) : null}
            </span>
            {a.id === pickedAgent?.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManageAgents}>Manage agents</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApprovalModeMenu({
  approvalMode,
  accountDefault,
  pickApprovalMode,
}: {
  approvalMode: ChatApprovalMode | "default";
  accountDefault: string;
  pickApprovalMode: (mode: keyof typeof APPROVAL_MODES) => void;
}) {
  // Icon-only on narrow screens: the icon must say which mode is active,
  // not always the shield.
  const ActiveIcon = approvalMode === "default" ? ShieldCheck : APPROVAL_MODES[approvalMode].icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={`h-8 gap-1 rounded-full px-2 pointer-coarse:h-10 ${
            approvalMode === "full_access"
              ? "text-orange-500 hover:text-orange-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title="How tool actions are approved in this chat"
        >
          <ActiveIcon className="size-4 shrink-0" />
          <span className="hidden sm:inline">
            {approvalMode === "default" ? accountDefault : APPROVAL_MODES[approvalMode].label}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          How should tool actions be approved?
        </DropdownMenuLabel>
        {(Object.keys(APPROVAL_MODES) as (keyof typeof APPROVAL_MODES)[]).map((m) => {
          const entry = APPROVAL_MODES[m];
          const Icon = entry.icon;
          return (
            <DropdownMenuItem key={m} onClick={() => pickApprovalMode(m)}>
              <div className="flex w-full items-start gap-2.5">
                <Icon className={`mt-0.5 size-4 shrink-0 ${entry.iconCls ?? "text-muted-foreground"}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{entry.label}</div>
                  <div className="text-xs text-muted-foreground">{entry.hint}</div>
                </div>
                {approvalMode === m && <Check className="mt-1 size-3.5 shrink-0" />}
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ComposerSend {
  steeringMessage: string | null;
  steerChip: (block: RenderBlock) => Promise<void>;
  withdrawChip: (block: RenderBlock) => Promise<void>;
  deliverOutgoing: (command: OutgoingCommand) => Promise<unknown>;
  send: (mode: "normal" | "queue" | "steer") => Promise<unknown>;
  requestStop: () => Promise<unknown>;
}

export function ThreadComposer({
  composer,
  sending,
  agent,
  approval,
  viewChatId,
  blocks,
  busy,
  navigating,
  holdingFirstSend,
  openGenerating,
  stopping,
  models,
  model,
  access,
  currentProject,
  localMachineId,
  chatWidth,
  chatResizing,
  setComposerEl,
  onManageAgents,
}: {
  composer: ComposerHandle;
  sending: ComposerSend;
  agent: AgentPick;
  approval: {
    approvalMode: ChatApprovalMode | "default";
    accountDefault: string;
    pickApprovalMode: (mode: keyof typeof APPROVAL_MODES) => void;
  };
  viewChatId: string | null;
  blocks: RenderBlock[];
  busy: boolean;
  navigating: boolean;
  /** A first send is in flight from the scratch surface: the composer
   *  stays frozen with its text until the route moves. */
  holdingFirstSend: boolean;
  openGenerating: boolean;
  stopping: Record<string, true>;
  models: readonly unknown[] | null;
  model: string;
  access: {
    readOnly: boolean;
    unknown: boolean;
    facts: ThreadFacts;
    foreign: boolean;
    deletingAgent: Agent | null;
    onUnarchive: () => void;
  };
  currentProject: PickedProject | null;
  localMachineId: string | undefined;
  chatWidth: number;
  chatResizing: boolean;
  setComposerEl: (el: HTMLDivElement | null) => void;
  onManageAgents: () => void;
}) {
  const {
    fileStore,
    prompt,
    setPrompt,
    promptRef,
    outgoingRef,
    setCaret,
    setMentionDismissed,
    mentionIndex,
    setMentionIndex,
    mentionMatches,
    acceptMention,
    ta,
    autoGrow,
    pending,
    setPending,
    fileInput,
    addFiles,
  } = composer;
  const { steeringMessage, steerChip, withdrawChip, deliverOutgoing, send, requestStop } = sending;
  const { facts, foreign } = access;
  const removePending = (id: string) =>
    setPending((p) =>
      p.filter((x) => {
        if (x.id !== id) return true;
        if (x.previewUrl) URL.revokeObjectURL(x.previewUrl);
        return false;
      }),
    );
  const queuedChips = blocks.filter((b) => b.kind === "user" && b.queued);

  // While a turn generates the composer stays usable: with content the send
  // queues (Ctrl/Cmd+Enter steers); empty, the button turns into Stop. A
  // clicked stop shows its own state (pulsing square, "Stopping…") until
  // the server's generating=false lands — the stop is cooperative
  // server-side, so this is the only immediate feedback the click can
  // honestly get. A first-send submit in flight (create/prepare/send round
  // trip, the chat not on the server yet) shows the pending spinner
  // instead: there is no turn to stop and nothing to send again.
  const submitting = holdingFirstSend;
  const generating = openGenerating || (busy && !submitting);
  const hasContent = !!prompt.trim() || pending.length > 0;
  const mode = sendButtonState({
    hasContent,
    hasModel: !!model,
    generating,
    stopping: !!viewChatId && !!stopping[viewChatId],
    submitting,
  });

  return (
    // The composer floats over the chat content; the scroll pane runs
    // full-height behind it and offsets it by its measured height. The
    // home-indicator inset is padding under the card, not a gap: most of
    // the inset becomes the strip the indicator sits in, so the card keeps
    // a short step above the edge instead of a dead band.
    <div
      ref={setComposerEl}
      data-composer
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/85 to-transparent px-3 pb-[max(1rem,calc(env(safe-area-inset-bottom)-0.25rem))] pt-6 sm:px-4"
    >
      {access.readOnly ? (
        <div
          className="pointer-events-auto mx-auto flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-lg pointer-coarse:rounded-[1.75rem]"
          style={{ maxWidth: chatWidth }}
        >
          <span className="min-w-0 flex-1">{readOnlyNotice(facts, foreign, access.deletingAgent)}</span>
          {facts.type === "user" && facts.archived && !facts.deleted && !foreign && (
            <Button variant="secondary" size="sm" onClick={access.onUnarchive}>
              Unarchive
            </Button>
          )}
        </div>
      ) : access.unknown ? (
        <div
          aria-label="Loading thread composer"
          className="pointer-events-auto mx-auto w-full rounded-xl border border-border bg-card p-2 shadow-lg backdrop-blur-sm pointer-coarse:rounded-[1.75rem]"
          style={{ maxWidth: chatWidth }}
        >
          <div className="px-2 py-1.5">
            <Skeleton className="h-5 w-2/5" />
          </div>
          <div className="flex items-center justify-between px-1 pt-1">
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="size-7 rounded-full" />
          </div>
        </div>
      ) : (
        <div
          className={`pointer-events-auto mx-auto w-full rounded-xl border border-border bg-card p-2 text-base shadow-lg backdrop-blur-sm pointer-coarse:rounded-[1.75rem] ${
            chatResizing ? "" : "transition-[max-width] duration-150"
          }`}
          style={{ maxWidth: chatWidth }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {queuedChips.length > 0 && (
            <div className="space-y-1.5 px-1 pb-2">
              {queuedChips.map((b) => (
                <div
                  key={b.key}
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
                >
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" title={b.text}>
                    {b.text}
                  </span>
                  {b.attachments && b.attachments.length > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">+{b.attachments.length}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {b.queuedKind === "child_result"
                      ? "Subagent result"
                      : b.queuedKind === "turn"
                        ? "Queued turn"
                        : b.queuedMode === "steer"
                          ? "Steer"
                          : "Queued"}
                  </span>
                  {b.queuedMode !== "steer" && b.eventId && (
                    <button
                      type="button"
                      disabled={steeringMessage === b.eventId}
                      className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      onClick={() => void steerChip(b)}
                      title="Send as guidance during the current response"
                    >
                      {steeringMessage === b.eventId ? "Steering…" : "Steer now"}
                    </button>
                  )}
                  {b.eventId && (
                    <button
                      type="button"
                      aria-label="Remove queued message"
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => void withdrawChip(b)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {[...outgoingRef.current.values()]
            .filter((c) => c.error && (c.chatId ?? c.originChatId) === viewChatId)
            .map((command) => (
              <div key={command.id} className="px-2 pb-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={command.text}>
                    Send needs retry: {command.text || "attachments"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={command.running}
                    onClick={() => void deliverOutgoing(command)}
                  >
                    Retry send
                  </Button>
                </div>
                {command.error && (
                  <div className="truncate text-xs text-muted-foreground/80" title={command.error}>
                    {command.error}
                  </div>
                )}
              </div>
            ))}
          {pending.length > 0 && (
            <div className="flex flex-wrap items-start gap-2 px-1 pb-2">
              {pending
                .filter((a) => a.modality === "image")
                .map((a) => (
                  <AttachmentImageThumb key={a.id} att={a} onRemove={() => removePending(a.id)} />
                ))}
              {pending
                .filter((a) => a.modality !== "image")
                .map((a) => (
                  <AttachmentFileChip key={a.id} att={a} onRemove={() => removePending(a.id)} />
                ))}
            </div>
          )}
          {mentionMatches.length > 0 && (
            <div
              data-scrollable
              className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-md"
            >
              {mentionMatches.map((sk, i) => (
                <button
                  key={sk.name}
                  type="button"
                  onMouseDown={(e) => {
                    // preventDefault keeps focus (and the caret) in the textarea
                    e.preventDefault();
                    acceptMention(sk.name);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                    i === Math.min(mentionIndex, mentionMatches.length - 1) ? "bg-accent" : ""
                  }`}
                >
                  <span className="text-sm font-medium">/{sk.name}</span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {sk.builtin
                      ? sk.description
                      : `${sk.description || "Installed org skill"} — the skill's instructions are attached when you send`}
                  </span>
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={ta}
            value={prompt}
            onChange={(e) => {
              fileStore.touchDraft(viewChatId);
              promptRef.current = e.target.value;
              setPrompt(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              autoGrow();
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={(e) => {
              // Clipboard files (screenshot copies, image copies) attach
              // like drag-and-drop instead of doing nothing.
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (navigating) return;
              if (mentionMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  acceptMention(mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)].name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                // An IME commits a candidate with Enter; that keystroke is
                // the commit, not a submit.
                if (isImeEnter(e)) return;
                e.preventDefault();
                // While a turn runs: Enter queues for the turn's next pause;
                // Ctrl/Cmd+Enter steers — interrupts the turn and sends
                // immediately.
                void send(busy ? (e.ctrlKey || e.metaKey ? "steer" : "queue") : "normal");
              }
            }}
            rows={1}
            placeholder={models === null || model ? "Type / for skills and commands" : "No model available"}
            data-scrollable
            // Not disabled while streaming: a disabled focused element blurs
            // to body, and the composer must keep focus/caret during
            // generation (send is guarded by `busy` anyway). readOnly (not
            // disabled) for the held first send too — the screen stays
            // frozen with the sent text until navigation.
            readOnly={holdingFirstSend || navigating}
            disabled={models !== null && !model}
            className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none"
          />
          {/* One line, never wrapping: on narrow screens the labeled badges
              collapse to their icons (text stays in the title tooltip). */}
          <div className="flex flex-nowrap items-center justify-between gap-x-2 px-1 pt-1">
            <div className="flex min-w-0 flex-nowrap items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-8 rounded-full text-muted-foreground hover:text-foreground pointer-coarse:size-10"
                onClick={() => fileInput.current?.click()}
                disabled={busy || navigating}
                title="Attach images, audio, or files"
                aria-label="Attach files"
              >
                <Plus className="size-4" />
              </Button>
              <ProjectChip chatId={viewChatId} project={currentProject} localMachineId={localMachineId} />
              <ApprovalModeMenu {...approval} />
              {models !== null && models.length === 0 && <span className="text-muted-foreground">no models</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ContextRing chatId={viewChatId} model={model} />
              <AgentChip agent={agent} onManageAgents={onManageAgents} />
              <Button
                size="icon"
                className="size-8 rounded-full pointer-coarse:size-10"
                onClick={() =>
                  mode === "stop" || mode === "stopping"
                    ? void requestStop()
                    : void send(generating ? "queue" : "normal")
                }
                disabled={
                  navigating ||
                  mode === "pending" ||
                  mode === "stopping" ||
                  (mode === "send" && (!model || !hasContent))
                }
                title={
                  mode === "stopping"
                    ? "Stopping…"
                    : mode === "stop"
                      ? "Stop"
                      : mode === "pending"
                        ? "Sending…"
                        : generating
                          ? "Queue (Ctrl+Enter sends immediately)"
                          : "Send"
                }
              >
                {mode === "stop" || mode === "stopping" ? (
                  <Square className={`size-3.5 fill-current ${mode === "stopping" ? "animate-pulse" : ""}`} />
                ) : mode === "pending" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
