// Sending: the outgoing command queue, its delivery round trip, recovery of
// failed sends, and the queued-chip actions.
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  createChat,
  machineId,
  prepareTurn,
  sendChatNoStream,
  setChatApproval,
  steerQueued,
  stopChat,
  uploadAttachment,
  withdrawQueued,
  compactChat,
  type ChatApprovalMode,
} from "../../../transport";
import { readDraft, writeDraft, type DraftStorage } from "../../../lib/drafts";
import {
  captureCommand,
  detachCommandDraft,
  forgetCommand,
  matchesCommandDraft,
  prepareOnSendingMachine,
  recoveryDraft,
  rememberCommand,
  submitCommand,
  type DraftAttachment,
  type OutgoingCommand,
} from "../../../lib/outgoing-command";
import type { Block, ThreadReducer } from "../../../lib/thread-reducer";
import { outgoingProjectId, type PickedProject } from "../../projects/projects";
import type { Agent } from "../../agents/agents-api";
import type { Project } from "../../../transport";
import type { RoutePatch } from "../route";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OutgoingDeps {
  chatId: string | null;
  model: string;
  busy: boolean;
  openGenerating: boolean;
  compacting: boolean;
  setCompacting: (v: boolean) => void;
  filesReady: boolean;
  promptRef: RefObject<string>;
  setPrompt: (v: string) => void;
  pendingRef: RefObject<DraftAttachment[]>;
  setPending: (v: DraftAttachment[]) => void;
  autoGrow: () => void;
  outgoingRef: RefObject<Map<string, OutgoingCommand>>;
  pendingDraftsRef: RefObject<Map<string | null, DraftAttachment[]>>;
  draftStorage: DraftStorage;
  fileStore: {
    saveCommand(command: OutgoingCommand): Promise<void>;
    forgetCommand(id: string): Promise<void>;
  };
  storageFailure: (reason?: unknown) => void;
  persistCommand: (command: OutgoingCommand) => Promise<void>;
  persistFiles: (target: string | null, files: readonly DraftAttachment[]) => void;
  mountedRef: RefObject<boolean>;
  deliveringRef: RefObject<Set<string>>;
  restoredCommandRef: RefObject<Map<string | null, string>>;
  refreshOutgoing: (update: (n: number) => number) => void;
  outgoingScope: string;
  reducerRef: RefObject<ThreadReducer>;
  setBlocks: (blocks: Block[]) => void;
  markBusy: (v: boolean) => void;
  openChatIdRef: RefObject<string | null>;
  loadSeq: RefObject<number>;
  sendingRef: RefObject<boolean>;
  refreshChats: () => Promise<void>;
  projects: Project[] | null;
  openRow: { machine_id?: string | null } | undefined;
  currentProject: PickedProject | null;
  pickedProjectRef: RefObject<PickedProject | null>;
  pickedAgentRef: RefObject<Agent | null>;
  approvalMode: ChatApprovalMode | "default";
  stopping: Record<string, true>;
  setStopping: Dispatch<SetStateAction<Record<string, true>>>;
  justCreatedApprovalRef: RefObject<string | null>;
  justCreatedBusyRef: RefObject<string | null>;
  pushRoute: (next: RoutePatch) => void;
}

export function useOutgoing(deps: OutgoingDeps) {
  const {
    chatId, model, busy, openGenerating, compacting, setCompacting, filesReady,
    promptRef, setPrompt, pendingRef, setPending, autoGrow, outgoingRef, pendingDraftsRef,
    draftStorage, fileStore, storageFailure, persistCommand, persistFiles, mountedRef,
    deliveringRef, restoredCommandRef, refreshOutgoing, outgoingScope, reducerRef, setBlocks,
    markBusy, openChatIdRef, loadSeq, sendingRef, refreshChats, projects, openRow,
    currentProject, pickedProjectRef, pickedAgentRef, approvalMode, stopping, setStopping,
    justCreatedApprovalRef, justCreatedBusyRef, pushRoute,
  } = deps;
  const [pendingSubmitId, setPendingSubmitId] = useState<string | null>(null);
  const [steeringMessage, setSteeringMessage] = useState<string | null>(null);

  const settleOutgoing = (command: OutgoingCommand) => {
    if (!mountedRef.current) return;
    command.accepted = true;
    outgoingRef.current.delete(command.id);
    forgetCommand(localStorage, outgoingScope, command.id);
    void fileStore.forgetCommand(command.id).catch(storageFailure);
    const target = command.chatId ?? command.originChatId;
    if (restoredCommandRef.current.get(target) === command.id) {
      const active = openChatIdRef.current === target;
      const draft = active ? promptRef.current : readDraft(draftStorage, target);
      const files = pendingDraftsRef.current.get(target) ?? [];
      if (matchesCommandDraft(command, draft, files)) {
        writeDraft(draftStorage, target, "");
        pendingDraftsRef.current.set(target, []);
        persistFiles(target, []);
        if (active) { promptRef.current = ""; setPrompt(""); setPending([]); requestAnimationFrame(autoGrow); }
      }
      restoredCommandRef.current.delete(target);
    }
    for (const a of command.attachments) {
      if (a.previewUrl && ![...pendingDraftsRef.current.values()].some(files => files.some(f => f.previewUrl === a.previewUrl))) {
        URL.revokeObjectURL(a.previewUrl);
      }
    }
    refreshOutgoing(n => n + 1);
  };

  const recoverOutgoing = (command: OutgoingCommand) => {
    const target = command.chatId ?? command.originChatId;
    const active = openChatIdRef.current === target;
    const newerText = active ? promptRef.current : readDraft(draftStorage, target);
    const newerFiles = pendingDraftsRef.current.get(target) ?? [];
    // A newer draft wins. The failed command stays available separately.
    const recovered = recoveryDraft(command, newerText, newerFiles);
    if (recovered.restored) {
      writeDraft(draftStorage, target, recovered.text);
      pendingDraftsRef.current.set(target, recovered.files);
      persistFiles(target, recovered.files);
      restoredCommandRef.current.set(target, command.id);
      if (active) {
        promptRef.current = recovered.text;
        setPrompt(recovered.text);
        setPending(recovered.files);
        requestAnimationFrame(autoGrow);
      }
    }
    refreshOutgoing(n => n + 1);
  };

  const deliverOutgoing = async (command: OutgoingCommand) => {
    if (!mountedRef.current) return;
    if (command.running || command.accepted || deliveringRef.current.has(command.id)) return;
    deliveringRef.current.add(command.id);
    try { await persistCommand(command); } catch { deliveringRef.current.delete(command.id); return; }
    if (!mountedRef.current) { deliveringRef.current.delete(command.id); return; }
    const target = command.chatId ?? command.originChatId;
    detachCommandDraft(command, {
      read: target => ({ text: openChatIdRef.current === target ? promptRef.current : readDraft(draftStorage, target),
        files: pendingDraftsRef.current.get(target) ?? [] }),
      clear: target => {
        writeDraft(draftStorage, target, "");
        pendingDraftsRef.current.set(target, []);
        persistFiles(target, []);
        // A first send holds the scratch composer as-is (text visible,
        // input blocked) until the create responds and the route moves —
        // clearing here would flash an emptied new-chat screen. The
        // created() handover below empties the composer at navigation.
        if (target !== null && openChatIdRef.current === target) { promptRef.current = ""; setPrompt(""); setPending([]); requestAnimationFrame(autoGrow); }
      },
    });
    if (command.accepted) { deliveringRef.current.delete(command.id); return; }
    const mySeq = loadSeq.current;
    if (target === null) {
      // First send: the chat does not exist yet, so nothing renders
      // optimistically — the composer's pending-submit spinner carries the
      // state until the create responds and the route moves.
      setPendingSubmitId(command.id);
      sendingRef.current = false;
    } else if (openChatIdRef.current === target) {
      markBusy(true);
      setBlocks(reducerRef.current.optimisticSend({ chatId: target, text: command.text,
        key: command.id, sentAt: command.sentAt,
        ...(command.sendMode ? { queued: true, queuedMode: command.sendMode } : {}),
        attachments: command.attachments.map(a => ({ ...a, file: undefined, id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}` })) }).blocks);
      sendingRef.current = true;
    } else {
      sendingRef.current = false;
    }
    try {
      await submitCommand(command, {
        checkpoint: persistCommand,
        create: async (_text, project) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          const cid = await createChat("", project);
          if (!cid) throw new Error("Chat create failed");
          return cid;
        },
        created: (cid) => {
          if (!mountedRef.current) return;
          // The chat exists server-side: from here the turn's submission is
          // an in-flight round trip against a real chat — pushes must keep
          // its busy until the server's generating flag takes over.
          sendingRef.current = true;
          if (loadSeq.current === mySeq && openChatIdRef.current === command.originChatId) {
            // The composer was held (blocked, text visible) on the scratch
            // surface for the whole create, so no follow-up typing exists:
            // the sent content travels as the optimistic send below, and
            // the thread opens with an empty composer.
            writeDraft(draftStorage, cid, "");
            writeDraft(draftStorage, command.originChatId, "");
            pendingDraftsRef.current.set(cid, []);
            pendingDraftsRef.current.set(command.originChatId, []);
            persistFiles(cid, []);
            persistFiles(command.originChatId, []);
            promptRef.current = "";
            setPrompt("");
            setPending([]);
            requestAnimationFrame(autoGrow);
            if (approvalMode !== "default") {
              justCreatedApprovalRef.current = cid;
              void setChatApproval(cid, approvalMode).catch(() => toast.error("Could not save approval mode"));
            }
            // Seed the created chat's view with the sent message so the
            // route push lands straight on the working thread — no
            // skeleton between the scratch surface and the thread state.
            setBlocks(reducerRef.current.optimisticSend({ chatId: cid, text: command.text,
              key: command.id, sentAt: command.sentAt,
              attachments: command.attachments.map(a => ({ ...a, file: undefined, id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}` })) }).blocks);
            justCreatedBusyRef.current = cid;
            markBusy(true);
            pushRoute({ chatId: cid, overlay: null });
            void refreshChats();
          }
        },
        upload: (cid, attachment) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          return uploadAttachment(cid, attachment.file!);
        },
        uploaded: (attachment, meta) => {
          if (!mountedRef.current) return;
          // The stamp persists with the attachment (localStorage and the
          // file store): a restored draft re-sends the server id instead of
          // its local identity.
          attachment.uploadedAs = meta;
          const changed = reducerRef.current.settleAttachment(command.id, `pending-${attachment.id}`, meta.id);
          if (openChatIdRef.current === command.chatId || loadSeq.current === mySeq) setBlocks(changed.blocks);
        },
        prepare: async (text, folder) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([prepareTurn(text, folder), new Promise<null>(resolve => {
              timer = setTimeout(() => resolve(null), 10_000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        },
        submit: async (cid, id, body) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          rememberCommand(localStorage, outgoingScope, command);
          await sendChatNoStream(cid, body.model, body.prompt, body.attachmentIds, body.projectId,
            id, body.sendMode, body.skillsIndex, body.instructions, pickedAgentRef.current?.id);
        },
      });
      settleOutgoing(command);
    } catch (e) {
      if (!mountedRef.current) return;
      const cid = command.chatId ?? command.originChatId;
      const failed = reducerRef.current.failSend(cid, command.id, e instanceof Error ? e.message : String(e));
      if (openChatIdRef.current === cid) { setBlocks(failed.blocks); markBusy(false); }
      recoverOutgoing(command);
    } finally {
      deliveringRef.current.delete(command.id);
      if (!mountedRef.current) return;
      setPendingSubmitId(cur => cur === command.id ? null : cur);
      sendingRef.current = [...outgoingRef.current.values()].some(c => c.running && (c.chatId ?? c.originChatId) === openChatIdRef.current);
      if (command.error && openChatIdRef.current === (command.chatId ?? command.originChatId)) markBusy(false);
      refreshOutgoing(n => n + 1);
    }
  };

  const send = async (mode: "normal" | "queue" | "steer" = "normal") => {
    if (!mountedRef.current || !filesReady) return;
    const text = promptRef.current.trim();
    if ((!text && pendingRef.current.length === 0) || !model) return;
    if (text.toLowerCase() === "/compact") {
      if (!chatId) { toast.error("Compact needs an existing chat — send a message first"); return; }
      if (compacting) { toast.info("Compaction is already running"); return; }
      promptRef.current = "";
      setPrompt("");
      requestAnimationFrame(autoGrow);
      setCompacting(reducerRef.current.setCompacting(chatId).compacting);
      try {
        if (!await compactChat(chatId)) toast.info("No compaction was needed");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setCompacting(reducerRef.current.finishCompacting(chatId).compacting);
      }
      return;
    }
    const retry = [...outgoingRef.current.values()].find(c => c.error && (c.chatId ?? c.originChatId) === chatId && matchesCommandDraft(c, text, pendingRef.current));
    if (retry) { await deliverOutgoing(retry); return; }
    const generating = busy || openGenerating;
    if (mode === "normal" && generating) return;
    if ([...outgoingRef.current.values()].some(c => deliveringRef.current.has(c.id) && !c.running && (c.chatId ?? c.originChatId) === chatId)) return;
    if (!chatId && [...outgoingRef.current.values()].some(c => c.running && c.originChatId === null)) return;
    const selected = currentProject ? projects?.find(p => p.id === currentProject.id) : undefined;
    const executor = selected?.machine_id ?? (currentProject ? openRow?.machine_id ?? undefined : undefined);
    const command = captureCommand({
      id: crypto.randomUUID(), originChatId: chatId, chatId, text,
      model,
      createProjectId: pickedProjectRef.current?.id ?? null,
      projectId: outgoingProjectId(pickedProjectRef.current),
      projectFolder: currentProject?.folder ?? selected?.folder,
      prepareLocally: prepareOnSendingMachine(isTauri, !!currentProject, executor ?? undefined, isTauri ? machineId() : ""),
      sendMode: generating ? (mode === "steer" ? "steer" : "queue") : undefined,
      attachments: pendingRef.current,
    });
    outgoingRef.current.set(command.id, command);
    // Persist the immutable file snapshot before detaching the composer.
    await deliverOutgoing(command);
  };

  const steerChip = useCallback(async (block: Block) => {
    if (!chatId || !block.eventId) return;
    setSteeringMessage(block.eventId);
    try {
      const outcome = await steerQueued(chatId, block.eventId);
      if (outcome === "pending") toast.info("Message is still being queued. Try again in a moment.");
      else if (outcome === "placed") toast.info("Message was just delivered to the agent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSteeringMessage(null);
    }
  }, [chatId]);

  /** Trash on a queued chip: withdraws the not-yet-placed send server-side.
   *  The chip drops on success; 409 means the input was just placed — the
   *  delivery flow converts it to a transcript bubble (refresh incoming). */
  const withdrawChip = useCallback(async (block: Block) => {
    const cid = chatId;
    if (!cid || !block.eventId) return;
    try {
      const ok = await withdrawQueued(cid, block.eventId);
      if (!ok) {
        toast.info("Message was just delivered to the agent");
        return;
      }
      setBlocks(reducerRef.current.dropQueued(cid, block.eventId).blocks);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [chatId]);

  /** Stops the chat's in-flight turn. 409 (nothing generating) resolves
   *  silently — the turn already ended between the render and the click. */
  const requestStop = async () => {
    const cid = chatId;
    if (!cid || stopping[cid]) return;
    setStopping((prev) => (prev[cid] ? prev : { ...prev, [cid]: true }));
    try {
      if (!(await stopChat(cid))) {
        setStopping((prev) => {
          if (!prev[cid]) return prev;
          const next = { ...prev };
          delete next[cid];
          return next;
        });
      }
    } catch {
      // the turn already ended or the stop failed; the feed's own state
      // settles the spinner
      setStopping((prev) => {
        if (!prev[cid]) return prev;
        const next = { ...prev };
        delete next[cid];
        return next;
      });
    }
  };

  return {
    pendingSubmitId,
    steeringMessage,
    settleOutgoing,
    recoverOutgoing,
    deliverOutgoing,
    send,
    steerChip,
    withdrawChip,
    requestStop,
  };
}
