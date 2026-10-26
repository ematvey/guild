// The composer's state and its persistence: per-chat drafts, attachment
// previews, the `/` mention menu, and the account-scoped file store that
// carries unsent sends across a reload.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { daemonFs } from "../../../lib/fs-bridge";
import { listSkills } from "../../../lib/skills";
import { applyMention, detectMention } from "../../../lib/skill-mention";
import {
  BrowserSendStore,
} from "../../../lib/browser-send-store";
import {
  canPersistDraft,
  clearDrafts,
  completeDraftInventory,
  gcDrafts,
  readDraft,
  scopedDraftStorage,
  writeDraft,
} from "../../../lib/drafts";
import {
  clearCommands,
  forgetCommand,
  matchesCommandDraft,
  restoreCommands,
  selectRestoredCommand,
  type DraftAttachment,
  type OutgoingCommand,
} from "../../../lib/outgoing-command";
import { fetchInstalls } from "../../skills/skills-api";
import { rpcCall } from "../../../lib/machine-rpc";
import { apiUrl } from "../../../lib/session";
import { BUILTIN_COMMANDS, composerSkills, mentionCandidates, type ComposerSkill } from "../mentions";
import { modalityOf } from "../attachments";
import { IS_TAURI } from "../../../lib/session";


export function useComposer({
  email,
  chatId,
  onSignOut,
  openChatIdRef,
}: {
  email: string;
  chatId: string | null;
  onSignOut: () => void;
  openChatIdRef: RefObject<string | null>;
}) {
  const outgoingScope = `${apiUrl("")}\n${email}`;
  const draftStorage = useMemo(() => scopedDraftStorage(localStorage, outgoingScope), [outgoingScope]);
  const [fileStore] = useState(() => new BrowserSendStore(outgoingScope));
  const storageWarningRef = useRef(false);
  const [filesReady, setFilesReady] = useState(false);
  const deliveringRef = useRef(new Set<string>());
  const observedUserIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const storageFailure = (reason?: unknown) => {
    console.error("Browser send storage write failed:", reason);
    if (!storageWarningRef.current && mountedRef.current) {
      storageWarningRef.current = true;
      toast.error("Attachments won't survive a reload on this browser");
    }
  };
  const persistCommand = async (command: OutgoingCommand) => {
    if (!mountedRef.current) throw new Error("Chat session closed");
    try { await fileStore.saveCommand(command); } catch (e) { storageFailure(e); }
  };
  const persistFiles = (target: string | null, files: readonly DraftAttachment[]) => {
    void fileStore.saveDraft(target, files).catch(storageFailure);
  };

  // Sign-out hygiene: drafts can hold sensitive composer text, so they are
  // cleared with the session — a shared browser's next account must not
  // inherit them. Every sign-out path in this view goes through here.
  const signOut = useCallback(() => {
    mountedRef.current = false;
    clearDrafts(draftStorage);
    clearCommands(localStorage, outgoingScope);
    void fileStore.clear().catch(() => {}).finally(onSignOut);
  }, [onSignOut, draftStorage, fileStore, outgoingScope]);

  const [prompt, setPrompt] = useState("");
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const [restoredOutgoing] = useState(() => restoreCommands(localStorage, outgoingScope));
  const outgoingRef = useRef(restoredOutgoing);
  const restoredCommandRef = useRef(new Map<string | null, string>());
  const [, refreshOutgoing] = useState(0);
  // The chat the chatId effect last restored a draft for (undefined = no
  // restore ran yet): the persist effect below writes only for this chat.
  const restoredForRef = useRef<string | null | undefined>(undefined);
  // Composer text persists per chat (localStorage, draftKey): every edit
  // writes the open chat's draft; the chatId effect swaps it on navigation
  // and sending overwrites it with "".
  useEffect(() => {
    // The gate: persist only after the chatId effect restored THIS chat's
    // draft. On a switch this effect runs first with the new chatId while
    // prompt still holds the previous chat's text — writing then would
    // clobber the destination chat's saved draft before its restore reads
    // it.
    if (!canPersistDraft(restoredForRef.current, chatId)) return;
    writeDraft(draftStorage, chatId, prompt);
  }, [prompt, chatId]);

  // ---- skill mentions: / opens the autocomplete (skills design §3) ----
  const [skills, setSkills] = useState<ComposerSkill[] | null>(null);
  const [caret, setCaret] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(() => {
    let cancelled = false;
    // The /-autocomplete pool = local + installed org skills (spec §2.3):
    // local rows exist only on Tauri (the fs bridge); org installs come
    // from the server in both modes — uninstalled org skills are never
    // fetched, so they can never be mentioned.
    const fs = IS_TAURI ? daemonFs(rpcCall) : null;
    const local = fs
      ? fs.scopes().then((scopes) => listSkills(fs, scopes)).catch(() => null)
      : Promise.resolve(null);
    Promise.all([local, fetchInstalls().catch(() => null)])
      .then(([rows, installs]) => {
        if (!cancelled) setSkills(composerSkills(rows as ComposerSkill[] | null, installs));
      })
      .catch(() => {
        /* skills are optional composer sugar — silence */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const mention = useMemo(
    () => (!mentionDismissed ? detectMention(prompt, caret) : null),
    [prompt, caret, mentionDismissed],
  );
  const mentionMatches = useMemo(
    () => (mention ? mentionCandidates(BUILTIN_COMMANDS, skills, mention.query) : []),
    [mention, skills],
  );
  // a fresh token re-opens the menu after Esc; typing within one stays closed
  useEffect(() => {
    setMentionDismissed(false);
  }, [mention?.start]);
  const acceptMention = useCallback(
    (name: string) => {
      const r = applyMention(prompt, caret, name);
      setPrompt(r.text);
      setCaret(r.caret);
      setMentionIndex(0);
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(r.caret, r.caret);
        autoGrow();
      });
    },
    [prompt, caret],
  );

  // Composer attachments: strip of previews above the input — image
  // thumbnails with an overlay ✕, file chips with an icon.
  const [pending, renderPending] = useState<DraftAttachment[]>([]);
  const pendingRef = useRef(pending);
  const [restoredAttachmentDrafts] = useState(() => {
    const drafts = new Map<string | null, DraftAttachment[]>();
    for (const command of restoredOutgoing.values()) {
      const target = command.chatId ?? command.originChatId;
      if (!drafts.has(target) && readDraft(draftStorage, target) === command.text) {
        drafts.set(target, command.attachments);
        restoredCommandRef.current.set(target, command.id);
      }
    }
    return drafts;
  });
  const pendingDraftsRef = useRef(restoredAttachmentDrafts);
  const pendingChatRef = useRef<string | null>(chatId);
  const setPending = (update: DraftAttachment[] | ((old: DraftAttachment[]) => DraftAttachment[])) => {
    const next = typeof update === "function" ? update(pendingRef.current) : update;
    pendingRef.current = next;
    pendingDraftsRef.current.set(pendingChatRef.current, next);
    persistFiles(pendingChatRef.current, next);
    renderPending(next);
  };
  useEffect(() => () => {
    const urls = new Set<string>();
    for (const files of pendingDraftsRef.current.values()) for (const a of files) if (a.previewUrl) urls.add(a.previewUrl);
    for (const command of outgoingRef.current.values()) for (const a of command.attachments) if (a.previewUrl) urls.add(a.previewUrl);
    for (const url of urls) URL.revokeObjectURL(url);
  }, []);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Drag-and-drop target state: the whole chat pane accepts attachment
  // drops, with a drop-hint overlay.
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (files: File[]) => {
    setPending((p) => [
      ...p,
      ...files.map((f) => ({
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: f.name,
        content_type: f.type || "application/octet-stream",
        size_bytes: f.size,
        modality: modalityOf(f.type),
        file: f,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      })),
    ]);
  };

  /** Swaps the composer to the destination chat's saved draft and files.
   *  Runs from the chatId effect, which owns navigation. */
  const restoreForChat = (cid: string | null) => {
    const restored = readDraft(draftStorage, cid);
    promptRef.current = restored;
    pendingChatRef.current = cid;
    pendingRef.current = pendingDraftsRef.current.get(cid) ?? [];
    renderPending(pendingRef.current);
    setPrompt(restored);
    setCaret(restored.length);
    restoredForRef.current = cid;
    if (restored) requestAnimationFrame(autoGrow);
  };

  // One account-scoped instance; navigation/edits are resolved through refs.
  useEffect(() => {
    let active = true;
    void fileStore.restore().then(({ drafts, commands }) => {
      if (!active || !mountedRef.current) {
        for (const files of drafts.values()) for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        for (const command of commands.values()) for (const file of command.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        return;
      }
      for (const [target, files] of drafts) pendingDraftsRef.current.set(target, files);
      pendingRef.current = pendingDraftsRef.current.get(openChatIdRef.current) ?? [];
      renderPending(pendingRef.current);
      for (const [id, loaded] of commands) {
        // The synchronous fallback records the exact submitted body even
        // when an IndexedDB checkpoint failed; never replace it with an
        // earlier upload/context snapshot.
        const existing = outgoingRef.current.get(id);
        const command = selectRestoredCommand(existing, loaded);
        if (command !== loaded) for (const file of loaded.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
        if (observedUserIdsRef.current.has(id)) {
          void fileStore.forgetCommand(id).catch(storageFailure);
          forgetCommand(localStorage, outgoingScope, id);
          for (const file of command.attachments) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
          continue;
        }
        outgoingRef.current.set(id, command);
        // Unfinished sends remain in their retry card. Composer records,
        // including intentionally emptied drafts, retain their own state.
      }
      // Files and text may both have been saved before a send detached its
      // composer. Keep their relationship so acceptance clears only that draft.
      for (const command of outgoingRef.current.values()) {
        const target = command.chatId ?? command.originChatId;
        const text = target === openChatIdRef.current ? promptRef.current : readDraft(draftStorage, target);
        if (matchesCommandDraft(command, text, pendingDraftsRef.current.get(target) ?? [])) restoredCommandRef.current.set(target, command.id);
      }
      refreshOutgoing(n => n + 1);
      setFilesReady(true);
    }).catch(() => { if (active) { storageFailure(); setFilesReady(true); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileStore]);

  /** Drops the draft keys of chats that left the sidebar lists. Unloaded
   *  lists prune nothing; observed chats and unresolved sends keep theirs. */
  const knownDraftChatsRef = useRef(new Set<string>());
  const gcDraftKeys = (
    chats: ReadonlyArray<{ id: string }> | null,
    archivedChats: ReadonlyArray<{ id: string }> | null,
  ) => {
    const keep = completeDraftInventory(chats, archivedChats, openChatIdRef.current);
    for (const chat of [...(chats ?? []), ...(archivedChats ?? [])]) knownDraftChatsRef.current.add(chat.id);
    if (keep) {
      for (const id of knownDraftChatsRef.current) keep.add(id);
      for (const command of outgoingRef.current.values()) if (command.chatId) keep.add(command.chatId);
      gcDrafts(draftStorage, keep);
    }
  };

  return {
    draftStorage,
    fileStore,
    filesReady,
    mountedRef,
    storageFailure,
    persistCommand,
    persistFiles,
    signOut,
    prompt,
    setPrompt,
    promptRef,
    restoredOutgoing,
    outgoingRef,
    restoredCommandRef,
    refreshOutgoing,
    restoredForRef,
    skills,
    caret,
    setCaret,
    mentionDismissed,
    setMentionDismissed,
    mentionIndex,
    setMentionIndex,
    mention,
    mentionMatches,
    acceptMention,
    ta,
    autoGrow,
    pending,
    setPending,
    pendingRef,
    pendingDraftsRef,
    pendingChatRef,
    fileInput,
    dragOver,
    setDragOver,
    addFiles,
    restoreForChat,
    gcDraftKeys,
    deliveringRef,
    observedUserIdsRef,
  };
}
