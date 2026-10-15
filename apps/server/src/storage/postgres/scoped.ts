import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { PostgresDurableStorage } from "./storage.js";

/** The empty page a scope-refused scan returns. */
const emptyPage = <T>(): Page<T, never> => ({ items: [] });

/** A storage view restricted to one conversation — the worker-per-chat
 *  boundary. pi-durable assumes one harness per storage: its scheduler
 *  adopts every live task and queued submission it can scan, so a worker
 *  process must never see another conversation's journal slice or two
 *  schedulers would re-drive each other's work. Guild owns the Postgres
 *  adapter, so the scope is enforced here: every scan that could surface
 *  foreign work is forced onto the scope conversation, and by-id readers
 *  refuse out-of-scope records. Writes are not re-checked: a scoped
 *  worker's session only commits to its own conversation, because every id
 *  it acts on came from its own scope-filtered reads.
 *
 *  The upstream ask (earendil-works/pi) is a first-class scoped harness;
 *  this adapter is the Guild-side implementation and keeps the same
 *  semantics. */
export class ScopedDurableStorage implements Storage {
  constructor(
    private readonly inner: PostgresDurableStorage,
    private readonly scope: ConversationId,
  ) {}

  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    return this.inner.commit(writes, context);
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return this.inner.mintId<I>();
  }

  async conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
    if (id !== this.scope) return undefined;
    return this.inner.conversation(id, context);
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    // The scope filter can drop most of a page, so walk inner pages until
    // the outer page fills or the inner scan exhausts; the last consumed
    // inner cursor is the outer one.
    const items: ConversationRecord[] = [];
    let innerCursor = cursor;
    for (;;) {
      const inner = await this.inner.scanConversations(query, limit, innerCursor, context);
      for (const record of inner.items) {
        if (record.id === this.scope) items.push(record);
      }
      innerCursor = inner.next;
      if (items.length >= limit || innerCursor === undefined) {
        return items.length >= limit ? ({ items: items.slice(0, limit), next: innerCursor } as Page<ConversationRecord, Cursor>) : { items };
      }
    }
  }

  async entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  async entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  async entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    maybeContext?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    if (maybeContext === undefined) {
      const hit = await this.inner.entry(idOrConversationId as EntryId, idOrContext as Context);
      if (!hit || hit.entry.conversationId !== this.scope) return undefined;
      return hit;
    }
    if (idOrConversationId !== this.scope) return undefined;
    return this.inner.entry(idOrConversationId, idOrContext as EntryId, maybeContext);
  }

  async findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    if (conversationId !== this.scope) return undefined;
    return this.inner.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
  }

  async scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    if (query.conversationId !== this.scope) return emptyPage();
    return this.inner.scanEntries(query, limit, cursor, context);
  }

  async task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
    const record = await this.inner.task(id, context);
    if (!record || record.conversationId !== this.scope) return undefined;
    return record;
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
    // The adoption scan: a foreign conversation filter must not widen the
    // view, so the scope is always ANDed.
    if (query.conversationId !== undefined && query.conversationId !== this.scope) return emptyPage();
    return this.inner.scanTasks({ ...query, conversationId: this.scope }, limit, cursor, context);
  }

  async submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
    const record = await this.inner.submission(id, context);
    if (!record || record.conversationId !== this.scope) return undefined;
    return record;
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    if (query.conversationId !== undefined && query.conversationId !== this.scope) return emptyPage();
    return this.inner.scanSubmissions({ ...query, conversationId: this.scope }, limit, cursor, context);
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ): Promise<SubmissionRecord | undefined> {
    if (conversationId !== this.scope) return undefined;
    return this.inner.submissionByRequest(conversationId, requestId, context);
  }

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
    // Document addresses are keyed by kind/scope/owner/family; conversation
    // documents carry the conversation in `owner`, task documents in the
    // owner task. The scoped session only resolves addresses derived from
    // its own scope-filtered reads, so no extra guard is needed here.
    return this.inner.findDocument(address, at, context);
  }

  document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
    return this.inner.document(id, at, context);
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.inner.scanDocuments(query, limit, cursor, context);
  }

  close(context: Context): Promise<void> {
    return this.inner.close(context);
  }
}
