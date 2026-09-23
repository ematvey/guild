import type { MessageAttachmentMeta } from "../transport";

export type DraftAttachment = MessageAttachmentMeta & { file?: File; previewUrl?: string };
export type PreparedCommand = {
  model: string;
  prompt: string;
  attachmentIds: string[];
  projectId?: string | null;
  sendMode?: "queue" | "steer";
  skillsIndex?: string;
  instructions?: string;
};

/** Owns the exact send, independently of navigation and later composer edits. */
export type OutgoingCommand = {
  id: string;
  originChatId: string | null;
  chatId: string | null;
  text: string;
  sentAt: number;
  model: string;
  projectId?: string | null;
  createProjectId: string | null;
  projectFolder?: string;
  prepareLocally: boolean;
  sendMode?: "queue" | "steer";
  attachments: DraftAttachment[];
  uploaded: Map<string, MessageAttachmentMeta>;
  prepared?: PreparedCommand;
  running: boolean;
  accepted: boolean;
  error?: string;
};

export function captureCommand(input: Omit<OutgoingCommand, "attachments" | "uploaded" | "running" | "accepted" | "sentAt"> & {
  attachments: readonly DraftAttachment[];
}): OutgoingCommand {
  return { ...input, attachments: input.attachments.map(a => ({ ...a })), uploaded: new Map(),
    running: false, accepted: false, sentAt: Date.now() };
}

export function matchesCommandDraft(command: OutgoingCommand, text: string, files: readonly DraftAttachment[]): boolean {
  return command.text === text.trim() && command.attachments.length === files.length
    && command.attachments.every((a, i) => a.id === files[i]?.id);
}

/** Unknown ownership is remote: never read a same-named local folder by accident. */
export function prepareOnSendingMachine(isDesktop: boolean, hasProject: boolean, projectMachine: string | undefined, senderMachine: string): boolean {
  return isDesktop && (!hasProject || projectMachine === senderMachine);
}

export type SubmissionIO = {
  create: (text: string, project: string | null) => Promise<string>;
  created: (chatId: string) => void;
  upload: (chatId: string, attachment: DraftAttachment) => Promise<MessageAttachmentMeta>;
  uploaded: (attachment: DraftAttachment, metadata: MessageAttachmentMeta) => void;
  prepare: (text: string, folder?: string) => Promise<{ prompt: string; index?: string; instructions?: string } | null>;
  submit: (chatId: string, id: string, payload: PreparedCommand) => Promise<void>;
  checkpoint?: (command: OutgoingCommand) => Promise<void>;
};

/** Retries reuse successful uploads, expanded context, payload and command ID.
 * A thrown submit may already have committed; only a durable echo/acceptance
 * settles that identity. Callers can reconcile `accepted` during an await. */
export async function submitCommand(command: OutgoingCommand, io: SubmissionIO): Promise<void> {
  if (command.running || command.accepted) return;
  command.running = true;
  command.error = undefined;
  try {
    await io.checkpoint?.(command);
    if (command.accepted) return;
    if (!command.chatId) {
      command.chatId = await io.create(command.text, command.createProjectId);
      await io.checkpoint?.(command);
      io.created(command.chatId);
    }
    for (const attachment of command.attachments) {
      if (command.uploaded.has(attachment.id)) continue;
      const meta = attachment.file ? await io.upload(command.chatId, attachment) : attachment;
      command.uploaded.set(attachment.id, meta);
      await io.checkpoint?.(command);
      io.uploaded(attachment, meta);
    }
    if (!command.prepared) {
      let prep: Awaited<ReturnType<SubmissionIO["prepare"]>> = null;
      if (command.prepareLocally) {
        try { prep = await io.prepare(command.text, command.projectFolder); } catch { /* optional local context */ }
      }
      command.prepared = {
        model: command.model, prompt: prep?.prompt ?? command.text,
        attachmentIds: command.attachments.map(a => command.uploaded.get(a.id)!.id),
        projectId: command.projectId, sendMode: command.sendMode,
        skillsIndex: prep?.index || undefined, instructions: prep?.instructions || undefined,
      };
    }
    await io.checkpoint?.(command);
    if (!command.accepted) await io.submit(command.chatId, command.id, command.prepared);
    command.accepted = true;
  } catch (error) {
    if (!command.accepted) {
      command.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  } finally {
    command.running = false;
  }
}

/** Recovery is conditional on the origin draft still being empty. */
export function recoveryDraft(command: OutgoingCommand, text: string, files: readonly DraftAttachment[]): { text: string; files: DraftAttachment[]; restored: boolean } {
  if (text || files.length) return { text, files: [...files], restored: false };
  return { text: command.text, files: [...command.attachments], restored: true };
}

const storagePrefix = (scope: string) => `guild:outgoing:${encodeURIComponent(scope)}:`;
export function rememberCommand(storage: Pick<Storage, "setItem">, scope: string, command: OutgoingCommand): void {
  if (!command.prepared || !command.chatId) return;
  try {
    storage.setItem(storagePrefix(scope) + command.id, JSON.stringify({ ...command,
      attachments: command.attachments.map(({ file: _file, previewUrl: _preview, ...meta }) => meta),
      uploaded: [...command.uploaded].map(([id, metadata]) => {
        const { file: _file, previewUrl: _preview, ...meta } = metadata as DraftAttachment;
        return [id, meta];
      }),
      running: false, accepted: false, error: "Delivery needs confirmation — retry this send",
    }));
  } catch { /* storage unavailable: the live command still retains its identity */ }
}
export function forgetCommand(storage: Pick<Storage, "removeItem">, scope: string, id: string): void {
  try { storage.removeItem(storagePrefix(scope) + id); } catch { /* storage unavailable */ }
}
export function restoreCommands(storage: Pick<Storage, "getItem" | "key" | "length">, scope: string): Map<string, OutgoingCommand> {
  const commands = new Map<string, OutgoingCommand>();
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(storagePrefix(scope))) continue;
      try {
        const row = JSON.parse(storage.getItem(key) ?? "null");
        if (!row || typeof row.id !== "string" || typeof row.chatId !== "string" || typeof row.text !== "string"
          || typeof row.prepared?.prompt !== "string" || !Array.isArray(row.prepared?.attachmentIds)
          || !Array.isArray(row.attachments) || !Array.isArray(row.uploaded)) continue;
        const uploaded = new Map<string, MessageAttachmentMeta>(row.uploaded);
        // Uploaded IDs are the reusable attachment identity after a reload;
        // browser-local files/object URLs no longer exist.
        const attachments = (row.attachments as DraftAttachment[]).map(a => uploaded.get(a.id) ?? a);
        commands.set(row.id, { ...row, attachments,
          uploaded: new Map(attachments.map(a => [a.id, a])), running: false, accepted: false });
      } catch { /* ignore malformed records individually */ }
    }
  } catch { /* storage unavailable */ }
  return commands;
}

export function clearCommands(storage: Pick<Storage, "removeItem" | "key" | "length">, scope: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(storagePrefix(scope))) keys.push(key); }
    for (const key of keys) storage.removeItem(key);
  } catch { /* storage unavailable */ }
}

/** Detach by origin identity even if navigation occurred while saving files. */
export function detachCommandDraft(command: OutgoingCommand, drafts: {
  read: (chatId: string | null) => { text: string; files: readonly DraftAttachment[] };
  clear: (chatId: string | null) => void;
}): void {
  const target = command.chatId ?? command.originChatId;
  const draft = drafts.read(target);
  if (matchesCommandDraft(command, draft.text, draft.files)) drafts.clear(target);
}

/** The synchronous POST snapshot wins if an async file checkpoint failed. */
export function selectRestoredCommand(existing: OutgoingCommand | undefined, loaded: OutgoingCommand): OutgoingCommand {
  return existing?.prepared ? existing : loaded;
}
