import type { DraftAttachment, OutgoingCommand } from "./outgoing-command";

export type StoredAttachment = Omit<DraftAttachment, "previewUrl">;
export type StoredCommand = Omit<OutgoingCommand, "attachments" | "uploaded"> & {
  attachments: StoredAttachment[];
  uploaded: Array<[string, StoredAttachment]>;
};
export type StoredRecord = { key: string; scope: string; kind: "draft" | "command"; id: string; value: StoredAttachment[] | StoredCommand };
export interface SendStorageBackend {
  load(scope: string): Promise<StoredRecord[]>;
  put(record: StoredRecord): Promise<void>;
  remove(key: string): Promise<void>;
  clear(scope: string): Promise<void>;
}
const key = (scope: string, kind: string, id: string) => JSON.stringify([scope, kind, id]);
const storedAttachment = ({ previewUrl: _preview, ...attachment }: DraftAttachment): StoredAttachment => ({ ...attachment });
export function serializeCommand(command: OutgoingCommand): StoredCommand {
  return { ...command, attachments: command.attachments.map(storedAttachment),
    uploaded: [...command.uploaded].map(([id, metadata]) => [id, storedAttachment(metadata)]),
    prepared: command.prepared ? { ...command.prepared, attachmentIds: [...command.prepared.attachmentIds] } : undefined,
    running: false, accepted: false, error: "Unfinished send — retry to continue" };
}
function restoreAttachment(attachment: StoredAttachment): DraftAttachment {
  const file = attachment.file instanceof Blob
    ? new File([attachment.file], attachment.filename, { type: attachment.content_type, lastModified: attachment.file.lastModified ?? Date.now() }) : undefined;
  return { ...attachment, file, previewUrl: file?.type.startsWith("image/") ? URL.createObjectURL(file) : undefined };
}
export function deserializeCommand(stored: StoredCommand): OutgoingCommand {
  return { ...stored, attachments: stored.attachments.map(restoreAttachment), uploaded: new Map(stored.uploaded),
    running: false, accepted: false, error: stored.error || "Unfinished send — retry to continue" };
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("guild-browser-sends", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "key" }).createIndex("scope", "scope");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Browser file storage is blocked"));
  }).catch(error => { database = undefined; throw error; });
  return database;
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("records", mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Browser file storage aborted"));
    try { run(tx.objectStore("records"), value => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}
export const indexedSendStorage: SendStorageBackend = {
  load: scope => transaction<StoredRecord[]>("readonly", (store, done) => {
    const request = store.index("scope").getAll(scope); request.onsuccess = () => done(request.result);
  }),
  put: record => transaction<void>("readwrite", store => { store.put(record); }),
  remove: id => transaction<void>("readwrite", store => { store.delete(id); }),
  clear: scope => transaction<void>("readwrite", store => {
    const request = store.index("scope").openKeyCursor(scope);
    request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
  }),
};

/** One account's serialized persistence lifecycle. Revision/settlement guards
 * apply synchronously, before any database await, including sign-out. */
export class BrowserSendStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private touched = new Set<string | null>();
  private settled = new Set<string>();
  constructor(readonly scope: string, private backend: SendStorageBackend = indexedSendStorage) {}
  touchDraft(chatId: string | null): void { this.touched.add(chatId); }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.tail.then(action); this.tail = work.catch(() => {}); return work;
  }
  saveDraft(chatId: string | null, attachments: readonly DraftAttachment[]): Promise<void> {
    this.touchDraft(chatId);
    if (this.closed) return Promise.resolve();
    const value = attachments.map(storedAttachment);
    return this.enqueue(() => this.backend.put({ key: key(this.scope, "draft", chatId ?? "new"), scope: this.scope, kind: "draft", id: chatId ?? "new", value }));
  }
  saveCommand(command: OutgoingCommand): Promise<void> {
    if (this.closed || this.settled.has(command.id) || command.accepted) return Promise.resolve();
    const value = serializeCommand(command);
    return this.enqueue(() => this.backend.put({ key: key(this.scope, "command", command.id), scope: this.scope, kind: "command", id: command.id, value }));
  }
  forgetCommand(id: string): Promise<void> {
    this.settled.add(id);
    if (this.closed) return Promise.resolve();
    return this.enqueue(() => this.backend.remove(key(this.scope, "command", id)));
  }
  async restore(): Promise<{ drafts: Map<string | null, DraftAttachment[]>; commands: Map<string, OutgoingCommand> }> {
    const records = await this.backend.load(this.scope);
    const drafts = new Map<string | null, DraftAttachment[]>();
    const commands = new Map<string, OutgoingCommand>();
    if (this.closed) return { drafts, commands };
    for (const record of records) {
      if (record.scope !== this.scope) continue;
      if (record.kind === "draft") {
        const chat = record.id === "new" ? null : record.id;
        if (!this.touched.has(chat) && Array.isArray(record.value)) drafts.set(chat, record.value.map(restoreAttachment));
      } else if (!this.settled.has(record.id) && !Array.isArray(record.value)) {
        commands.set(record.id, deserializeCommand(record.value));
      }
    }
    return { drafts, commands };
  }
  clear(): Promise<void> {
    this.closed = true;
    return this.enqueue(() => this.backend.clear(this.scope));
  }
}
