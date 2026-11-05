// Sending: the outgoing command queue, its delivery round trip, recovery of
// failed sends, and the queued-chip actions.
import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import {
  createChat,
  sendChatNoStream,
  steerQueued,
  stopChat,
  uploadAttachment,
  withdrawQueued,
  compactChat,
} from "../../../lib/api/chats";
import { machineId } from "../../../lib/machine-rpc";
import { prepareTurn } from "../../../lib/api/skills";
import { setChatApproval, type ChatApprovalMode } from "../../../lib/api/approvals";
import { readDraft, writeDraft } from "../../../lib/drafts";
import {
  captureCommand,
  detachCommandDraft,
  forgetCommand,
  matchesCommandDraft,
  prepareOnSendingMachine,
  recoveryDraft,
  rememberCommand,
  submitCommand,
  type OutgoingCommand,
} from "../../../lib/outgoing-command";
import type { RenderBlock } from "../../../lib/thread-reducer";
import { outgoingProjectId, type PickedProject } from "../../projects/projects";
import type { Agent } from "../../agents/agents-api";
import { projectsStore } from "../chat-stores";
import type { ComposerHandle } from "./use-composer";
import type { ThreadStoreHandle } from "./use-thread-store";
import type { RoutePatch } from "../route";
import { HAS_ENGINE } from "../../../lib/session";
import { withTimeout } from "../../../lib/timeout";

export interface OutgoingDeps {
  /** The composer's draft, attachments and stored queue (useComposer). */
  composer: ComposerHandle;
  /** The open view's thread store (useThreadStore). */
  thread: ThreadStoreHandle;
  chatId: string | null;
  model: string;
  busy: boolean;
  /** Where this session's outgoing commands are stored. */
  outgoingScope: string;
  /** What a send binds, as the composer shows it. */
  target: {
    openRow: { machine_id?: string | null } | undefined;
    currentProject: PickedProject | null;
    pickedProjectRef: RefObject<PickedProject | null>;
    pickedAgentRef: RefObject<Agent | null>;
    approvalMode: ChatApprovalMode | "default";
  };
  /** Chats the first send created, whose fresh state the view must not
   *  refetch over. */
  justCreatedApprovalRef: RefObject<string | null>;
  justCreatedChatRef: RefObject<string | null>;
  pushRoute: (next: RoutePatch) => void;
}

export function useOutgoing(deps: OutgoingDeps) {
  const {
    composer,
    thread,
    chatId,
    model,
    busy,
    outgoingScope,
    target,
    justCreatedApprovalRef,
    justCreatedChatRef,
    pushRoute,
  } = deps;
  const {
    filesReady,
    promptRef,
    setPrompt,
    pendingRef,
    setPending,
    autoGrow,
    outgoingRef,
    pendingDraftsRef,
    draftStorage,
    fileStore,
    storageFailure,
    persistCommand,
    persistFiles,
    mountedRef,
    deliveringRef,
    restoredCommandRef,
    refreshOutgoing,
  } = composer;
  const { store, setSendPending, openChatIdRef, loadSeq, stopping, setStopping } = thread;
  const { compacting } = thread.view;
  const { openRow, currentProject, pickedProjectRef, pickedAgentRef, approvalMode } = target;
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
        if (active) {
          promptRef.current = "";
          setPrompt("");
          setPending([]);
          requestAnimationFrame(autoGrow);
        }
      }
      restoredCommandRef.current.delete(target);
    }
    for (const a of command.attachments) {
      if (
        a.previewUrl &&
        ![...pendingDraftsRef.current.values()].some((files) => files.some((f) => f.previewUrl === a.previewUrl))
      ) {
        URL.revokeObjectURL(a.previewUrl);
      }
    }
    refreshOutgoing((n) => n + 1);
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
    refreshOutgoing((n) => n + 1);
  };

  const deliverOutgoing = async (command: OutgoingCommand) => {
    if (!mountedRef.current) return;
    if (command.running || command.accepted || deliveringRef.current.has(command.id)) return;
    deliveringRef.current.add(command.id);
    try {
      await persistCommand(command);
    } catch {
      deliveringRef.current.delete(command.id);
      return;
    }
    if (!mountedRef.current) {
      deliveringRef.current.delete(command.id);
      return;
    }
    const target = command.chatId ?? command.originChatId;
    detachCommandDraft(command, {
      read: (target) => ({
        text: openChatIdRef.current === target ? promptRef.current : readDraft(draftStorage, target),
        files: pendingDraftsRef.current.get(target) ?? [],
      }),
      clear: (target) => {
        writeDraft(draftStorage, target, "");
        pendingDraftsRef.current.set(target, []);
        persistFiles(target, []);
        // A first send holds the scratch composer as-is (text visible,
        // input blocked) until the create responds and the route moves —
        // clearing here would flash an emptied new-chat screen. The
        // created() handover below empties the composer at navigation.
        if (target !== null && openChatIdRef.current === target) {
          promptRef.current = "";
          setPrompt("");
          setPending([]);
          requestAnimationFrame(autoGrow);
        }
      },
    });
    if (command.accepted) {
      deliveringRef.current.delete(command.id);
      return;
    }
    const mySeq = loadSeq.current;
    // A first send moves the route only once the server holds the send: the
    // scratch composer stays frozen (text visible, spinner) through create,
    // uploads and submit, and the thread then opens on its working state.
    // A failed submit opens the created chat too, where the failure shows.
    const openCreated = (accepted: boolean) => {
      const cid = command.chatId;
      if (target !== null || !cid || !mountedRef.current) return;
      if (loadSeq.current !== mySeq || openChatIdRef.current !== command.originChatId) return;
      // No follow-up typing exists on the frozen composer: the sent content
      // travels as the optimistic send, and the thread opens empty-handed.
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
      // Seed the created chat's view with the sent message so the route
      // push lands straight on the thread — no skeleton in between.
      store.mutate((r) =>
        r.optimisticSend({
          chatId: cid,
          text: command.text,
          key: command.id,
          sentAt: command.sentAt,
          attachments: command.attachments.map((a) => ({
            ...a,
            file: undefined,
            id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}`,
          })),
        }),
      );
      store.seed(cid);
      justCreatedChatRef.current = cid;
      // The turn is live server-side; until the chat's state echoing this
      // message arrives, the pending send holds `busy`.
      if (accepted) setSendPending(cid, "created", command.id);
      pushRoute({ chatId: cid, projectId: command.projectId, overlay: null });
    };
    if (target === null) {
      // First send: the chat does not exist yet, so nothing renders
      // optimistically — the composer's pending-submit spinner carries the
      // state until the server accepts the send and the route moves.
      setPendingSubmitId(command.id);
    } else if (openChatIdRef.current === target) {
      setSendPending(target, "optimistic_send", command.id);
      store.mutate((r) =>
        r.optimisticSend({
          chatId: target,
          text: command.text,
          key: command.id,
          sentAt: command.sentAt,
          ...(command.sendMode ? { queued: true, queuedMode: command.sendMode } : {}),
          attachments: command.attachments.map((a) => ({
            ...a,
            file: undefined,
            id: command.uploaded.get(a.id)?.id ?? `pending-${a.id}`,
          })),
        }),
      );
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
          if (approvalMode !== "default" && openChatIdRef.current === command.originChatId) {
            justCreatedApprovalRef.current = cid;
            void setChatApproval(cid, approvalMode).catch(() => toast.error("Could not save approval mode"));
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
          store.mutate((r) => r.settleAttachment(command.id, `pending-${attachment.id}`, meta.id));
        },
        prepare: async (text, folder) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          return withTimeout(prepareTurn(text, folder), 10_000, () => null);
        },
        submit: async (cid, id, body) => {
          if (!mountedRef.current) throw new Error("Chat session closed");
          rememberCommand(localStorage, outgoingScope, command);
          await sendChatNoStream(
            cid,
            body.model,
            body.prompt,
            body.attachmentIds,
            body.projectId,
            id,
            body.sendMode,
            body.skillsIndex,
            body.instructions,
            pickedAgentRef.current?.id,
          );
        },
      });
      openCreated(true);
      settleOutgoing(command);
    } catch (e) {
      if (!mountedRef.current) return;
      openCreated(false);
      const cid = command.chatId ?? command.originChatId;
      store.mutate((r) => r.failSend(cid, command.id, e instanceof Error ? e.message : String(e)));
      if (openChatIdRef.current === cid) setSendPending(null, "send_failed");
      recoverOutgoing(command);
    } finally {
      deliveringRef.current.delete(command.id);
      if (mountedRef.current) {
        setPendingSubmitId((cur) => (cur === command.id ? null : cur));
        if (command.error && openChatIdRef.current === (command.chatId ?? command.originChatId))
          setSendPending(null, "command_error");
        refreshOutgoing((n) => n + 1);
      }
    }
  };

  /** Sends the composer's draft, or `message` in its place: a message
   *  that comes from the transcript (a Generated UI button) leaves the
   *  draft and its files alone, and queues while a turn runs. */
  const send = async (mode: "normal" | "queue" | "steer" = "normal", message?: string) => {
    if (!mountedRef.current || !filesReady) return;
    const fromComposer = message === undefined;
    const text = fromComposer ? promptRef.current.trim() : message.trim();
    const attachments = fromComposer ? pendingRef.current : [];
    if ((!text && attachments.length === 0) || !model) return;
    if (!fromComposer && busy && mode === "normal") mode = "queue";
    if (fromComposer && text.toLowerCase() === "/compact") {
      if (!chatId) {
        toast.error("Compact needs an existing chat — send a message first");
        return;
      }
      if (compacting) {
        toast.info("Compaction is already running");
        return;
      }
      promptRef.current = "";
      setPrompt("");
      requestAnimationFrame(autoGrow);
      // The line stays up until the server reports the compaction over
      // (the reducer settles it from the thread state's `compacting` flag
      // or the durable summary); a request that started no task, or failed,
      // lowers it here.
      store.mutate((r) => r.setCompacting(chatId));
      try {
        const started = await compactChat(chatId);
        if (started !== null) {
          store.mutate((r) => r.compactStarted(chatId, started.seq));
        } else {
          toast.info("No compaction was needed");
          store.mutate((r) => r.finishCompacting(chatId));
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
        store.mutate((r) => r.finishCompacting(chatId));
      }
      return;
    }
    const retry = [...outgoingRef.current.values()].find(
      (c) => c.error && (c.chatId ?? c.originChatId) === chatId && matchesCommandDraft(c, text, attachments),
    );
    if (retry) {
      await deliverOutgoing(retry);
      return;
    }
    if (mode === "normal" && busy) return;
    if (
      [...outgoingRef.current.values()].some(
        (c) => deliveringRef.current.has(c.id) && !c.running && (c.chatId ?? c.originChatId) === chatId,
      )
    )
      return;
    if (!chatId && [...outgoingRef.current.values()].some((c) => c.running && c.originChatId === null)) return;
    const selected = currentProject ? projectsStore.get()?.find((p) => p.id === currentProject.id) : undefined;
    const executor = selected?.machine_id ?? (currentProject ? (openRow?.machine_id ?? undefined) : undefined);
    const command = captureCommand({
      id: crypto.randomUUID(),
      originChatId: chatId,
      chatId,
      text,
      model,
      createProjectId: pickedProjectRef.current?.id ?? null,
      projectId: outgoingProjectId(pickedProjectRef.current),
      projectFolder: currentProject?.folder ?? selected?.folder,
      prepareLocally: prepareOnSendingMachine(
        HAS_ENGINE,
        !!currentProject,
        executor ?? undefined,
        HAS_ENGINE ? machineId() : "",
      ),
      sendMode: busy ? (mode === "steer" ? "steer" : "queue") : undefined,
      attachments,
    });
    outgoingRef.current.set(command.id, command);
    // Persist the immutable file snapshot before detaching the composer.
    await deliverOutgoing(command);
  };

  const steerChip = useCallback(
    async (block: RenderBlock) => {
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
    },
    [chatId],
  );

  /** Trash on a queued chip: withdraws the not-yet-placed send server-side.
   *  The chip drops on success; 409 means the input was just placed — the
   *  delivery flow converts it to a transcript bubble (refresh incoming). */
  const withdrawChip = useCallback(
    async (block: RenderBlock) => {
      const cid = chatId;
      if (!cid || !block.eventId) return;
      try {
        const ok = await withdrawQueued(cid, block.eventId);
        if (!ok) {
          toast.info("Message was just delivered to the agent");
          return;
        }
        store.mutate((r) => r.dropQueued(cid, block.eventId!));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [chatId],
  );

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
