import { randomUUID } from "node:crypto";
import { apply, applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { Context } from "@earendil-works/chord";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentCopySource,
  DocumentContent,
  DocumentCreate,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  JsonObject,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  ScanOrder,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "@earendil-works/pi-durable";
import type { PostgresDatabase, PostgresExecutor } from "./executor.js";
import { rebuildLiveProjection } from "./live-projection.js";
import { applyPostgresMigrations } from "./migrations.js";
import { isTransientDbError, RETRY_DELAYS_MS, sleep } from "./pg.js";

// pi-durable 1.0.1 does not export its branding helpers from the package entry;
// the erased brands are phantom types, so trusted numeric boundaries brand with casts.
const asConversationId = (value: number) => value as ConversationId;
const asEntryId = (value: number) => value as EntryId;
const asDocumentId = (value: number) => value as DocumentId;
const asSeq = (value: number) => value as Seq;

const encodeJson = (value: unknown): string => JSON.stringify(value);
const parseJson = (value: unknown): unknown => JSON.parse(value as string);
// Postgres TEXT holds valid UTF-8 only, so indexed string identities (kind, key,
// request ID) are stored JSON-escaped to keep lone surrogates lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

const cursorId = (cursor: Cursor | undefined): number | undefined => {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new TypeError("Invalid storage cursor");
  return after;
};

interface CursorPosition {
  after: number | undefined;
  order: ScanOrder;
}

/** Resolves a scan's cursor position and order: a cursor continues in the
 *  order it was returned with, and a query asking for the other order is an
 *  invalid request (the cursor is backend-owned continuation state). */
const resolveCursor = (
  cursor: Cursor | undefined,
  requested: ScanOrder | undefined,
  defaultOrder: ScanOrder,
  label: string,
): CursorPosition => {
  if (cursor === undefined) return { after: undefined, order: requested ?? defaultOrder };
  const after = cursorId(cursor);
  const order = cursor.order;
  if (order !== "ascending" && order !== "descending") {
    throw new StorageRequestError(`${label} cursor is missing its scan order`);
  }
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(`${label} cursor continues in ${order} order; the query asks for ${requested}`);
  }
  return { after, order };
};

const bind = (params: unknown[], value: unknown): string => {
  params.push(value);
  return `$${params.length}`;
};

const page = <T extends { id: number }, C>(values: readonly T[], limit: number, order: ScanOrder): Page<T, C> => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1)!.id, order } as C };
};

const idClause = (operator: ">" | "<", placeholder: string): string => `id ${operator} ${placeholder}`;

const orderSql = (order: ScanOrder): string => (order === "ascending" ? "ASC" : "DESC");

/** The scan's id comparison against the cursor: a cursor continues strictly
 *  after (ascending) or strictly before (descending) its last returned id. */
const scanStart = (position: CursorPosition, defaultStart: number): { clause: string; params: unknown[] } => {
  const ascending = position.order === "ascending";
  const params: unknown[] = [position.after ?? (ascending ? defaultStart : Number.MAX_SAFE_INTEGER)];
  return { clause: idClause(ascending ? ">" : "<", "$1"), params };
};

const scopeColumns = (scope: DocumentRecord["scope"]): { scopeKind: string; ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
};

const addressParts = (address: DocumentAddress) => {
  const scope = scopeColumns(address.scope);
  return {
    kind: encodeIndexedString(address.kind),
    ...scope,
    family: address.key === undefined ? false : true,
    keyValue: encodeIndexedString(address.key ?? ""),
  };
};

const addressKey = (record: DocumentCreate | DocumentRecord): string => {
  const parts = addressParts({ kind: record.kind, scope: record.scope, key: record.key });
  return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === "current") return record.retiredAt === undefined;
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
  record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): number | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return write.value.id;
    case "document.create":
    case "document.copy":
      return write.record.id;
    case "document.change":
    case "document.retire":
      return undefined;
  }
};

interface DocumentAction {
  retire: boolean;
  create?: DocumentCreate;
  content?: DocumentContent;
  copy?: DocumentCopySource;
  liveValue?: JsonObject;
}

/**
 * Portable Postgres implementation of the pi-durable `Storage` contract.
 *
 * Pure logic lives here; the backend supplies the `PostgresDatabase` facade.
 * Records are read back from JSONB, so every read returns a detached value
 * matching the ownership boundary of serialization-backed stores.
 */
export class PostgresDurableStorage implements Storage {
  private readonly liveRevisions = new Map<DocumentId, number>();
  private readonly liveValues = new Map<DocumentId, JsonObject>();
  private nextId: number;
  private closed = false;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly db: PostgresDatabase,
    nextId: number,
  ) {
    this.nextId = nextId;
  }

  /** Apply pending migrations, then open storage over an owned Postgres facade. */
  static async open(db: PostgresDatabase): Promise<PostgresDurableStorage> {
    try {
      await applyPostgresMigrations(db);
      const rows = await db.query<{ next_id: number; next_seq: number }>(
        "SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1",
      );
      if (rows.length === 0) throw new Error("Durable Postgres metadata is missing");
      return new PostgresDurableStorage(db, rows[0]!.next_id);
    } catch (error) {
      try {
        await db.close();
      } catch {
        // Preserve the initialization failure.
      }
      throw error;
    }
  }

  /** Repairs only the built-in latest live projection, before a scheduler opens.
   * The metadata lock fences repair against commits. Authoritative records stay
   * untouched, and damaged revisions remain available in the repair journal. */
  async repairLiveProjections(conversationId?: ConversationId): Promise<DocumentId[]> {
    this.assertOpen();
    return this.db.transaction(async tx => {
      const metadata = await tx.query<{ next_seq: number }>("SELECT next_seq FROM durable_metadata WHERE singleton=1 FOR UPDATE");
      let seq = Number(metadata[0]!.next_seq);
      const rows = await tx.query<{ id: number; owner_id: number; record: string }>(
        `SELECT id,owner_id,record FROM documents WHERE kind=$1 AND scope_kind='conversation' AND retired_at IS NULL${conversationId === undefined ? "" : " AND owner_id=$2"} ORDER BY id`,
        conversationId === undefined ? [encodeIndexedString("pi.live")] : [encodeIndexedString("pi.live"), conversationId],
      );
      const repaired: DocumentId[] = [];
      for (const row of rows) {
        const id = asDocumentId(Number(row.id));
        try {
          await this.materializeDocument(tx, id, "current");
          continue;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "PathError") throw error;
          const record = parseJson(row.record) as DocumentRecord;
          if (!isCurrentOnly(record)) throw error;
          const revisions = await tx.query<{ seq: number; kind: string; version: number; content: string }>("SELECT seq,kind,version,content FROM document_revisions WHERE document_id=$1 ORDER BY seq", [id]);
          if (revisions.some(revision => revision.version !== 1)) throw error;
          const value = await rebuildLiveProjection(tx, Number(row.owner_id));
          // Also fence writers holding a revision beyond the metadata watermark.
          const repairSeq = revisions.reduce((next, revision) => Math.max(next, Number(revision.seq) + 1), seq);
          await tx.query("INSERT INTO live_projection_repairs(document_id,repaired_at_seq,conversation_id,reason,revisions) VALUES ($1,$2,$3,$4,$5)", [id, repairSeq, row.owner_id, error.message, encodeJson(revisions)]);
          await tx.query("DELETE FROM document_revisions WHERE document_id=$1", [id]);
          await tx.query("INSERT INTO document_revisions(document_id,seq,kind,version,content) VALUES ($1,$2,'base',1,$3)", [id, repairSeq, encodeJson(value)]);
          seq = repairSeq + 1;
          this.liveRevisions.delete(id);
          this.liveValues.delete(id);
          repaired.push(id);
        }
      }
      if (repaired.length) await tx.query("UPDATE durable_metadata SET next_seq=$1 WHERE singleton=1", [seq]);
      return repaired;
    });
  }

  async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    this.assertOpen();
    const documentActions = this.prepareDocumentActions(writes);
    const candidateNextId = this.candidateNextId(writes);
    const fingerprint = `commit:${randomUUID()}`;
    // Adoption and retry arm only after THIS call saw a connection-class
    // failure: that is the only situation where the outcome is genuinely
    // unknown. A clean attempt (a first-seen ID conflict, say) must reject
    // exactly as the storage contract demands — the conformance suite
    // re-commits already-claimed IDs and expects the throw.
    let sawTransient = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.commitOnce(writes, documentActions, candidateNextId, fingerprint);
      } catch (error) {
        if (isTransientDbError(error)) sawTransient = true;
        // The failed attempt may have committed: the connection can die
        // after the backend applied the transaction but before the client
        // learns the outcome. The durable_commits row identifies an
        // applied batch by its invocation identity — adopt instead of
        // double-applying (the ID claims would reject the retry) or
        // failing the session.
        if (sawTransient && fingerprint !== undefined) {
          const adopted = await this.adoptCommit(fingerprint).catch(() => undefined);
          if (adopted !== undefined) {
            this.nextId = Math.max(this.nextId, candidateNextId);
            this.adoptLiveValues(documentActions, adopted);
            return adopted;
          }
        }
        if (!sawTransient || attempt >= RETRY_DELAYS_MS.length) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
    }
  }

  private async commitOnce(
    writes: readonly StorageWrite[],
    documentActions: Map<DocumentId, DocumentAction>,
    candidateNextId: number,
    fingerprint: string | undefined,
  ): Promise<Seq> {
    const seq = await this.db.transaction(async (tx) => {
      // FOR UPDATE serializes concurrent commits on the metadata row.
      const metadata = await tx.query<{ next_id: number; next_seq: number }>(
        "SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1 FOR UPDATE",
      );
      if (metadata.length === 0) throw new Error("Durable Postgres metadata is missing");
      const committedSeq = asSeq(metadata[0]!.next_seq);
      // The metadata lock also waits for an earlier ambiguous attempt. Check
      // its receipt before applying any deltas a second time.
      if (fingerprint !== undefined) {
        const receipt = await tx.query<{ seq: number }>("SELECT seq FROM durable_commits WHERE key = $1", [fingerprint]);
        if (receipt[0]) return asSeq(receipt[0].seq);
      }
      await this.checkGlobalIds(tx, writes);
      await this.checkDocumentActions(tx, documentActions);
      for (const write of writes) await this.applyTableWrite(tx, write, committedSeq);
      await this.applyDocumentActions(tx, documentActions, committedSeq);
      if (fingerprint !== undefined) {
        await tx.query("INSERT INTO durable_commits (key, seq) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [
          fingerprint,
          committedSeq,
        ]);
      }
      await tx.query("UPDATE durable_metadata SET next_id = $1, next_seq = $2 WHERE singleton = 1", [
        Math.max(metadata[0]!.next_id, candidateNextId),
        committedSeq + 1,
      ]);
      return committedSeq;
    });
    this.nextId = Math.max(this.nextId, candidateNextId);
    this.adoptLiveValues(documentActions, seq);
    return seq;
  }

  private adoptLiveValues(actions: Map<DocumentId, DocumentAction>, seq: Seq): void {
    for (const [id, action] of actions) {
      if (!this.liveRevisions.has(id) && action.create?.kind !== "pi.live" && action.liveValue === undefined) continue;
      if (action.retire) {
        this.liveRevisions.delete(id);
        this.liveValues.delete(id);
        continue;
      }
      if (!action.content) continue;
      this.liveRevisions.set(id, Number(seq));
      const value = action.liveValue ?? (action.content.kind === "base" ? action.content.value : undefined);
      if (value !== undefined) this.liveValues.set(id, structuredClone(value));
    }
  }

  /** The sequence stored by an earlier attempt of this commit invocation. */
  private async adoptCommit(fingerprint: string): Promise<Seq | undefined> {
    const rows = await this.db.query<{ seq: number }>("SELECT seq FROM durable_commits WHERE key = $1", [fingerprint]);
    return rows.length === 0 ? undefined : asSeq(rows[0]!.seq);
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.assertOpen();
    // Cross-process safe: with worker-per-chat, several harnesses mint from
    // one id space, so the counter lives in the metadata row and each mint
    // is its own atomic increment. The in-memory watermark is only a floor
    // now (commits still advance it monotonically via Math.max).
    const rows = await this.db.query<{ id: number }>(
      "UPDATE durable_metadata SET next_id = next_id + 1 WHERE singleton = 1 RETURNING next_id - 1 AS id",
    );
    if (rows.length === 0) throw new Error("Durable Postgres metadata is missing");
    const id = rows[0]!.id;
    if (!Number.isSafeInteger(id)) throw new Error("ID space is exhausted");
    this.nextId = Math.max(this.nextId, id + 1);
    return id as unknown as I;
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    this.assertOpen();
    const rows = await this.db.query("SELECT record FROM conversations WHERE id = $1", [id]);
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as ConversationRecord);
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    this.assertOpen();
    const position = resolveCursor(cursor, query.order, "ascending", "conversation scan");
    const start = scanStart(position, -1);
    const params = [...start.params];
    const clauses = [start.clause];
    if (query.ownerConversationId !== undefined) {
      clauses.push(`owner_conversation_id = ${bind(params, query.ownerConversationId)}`);
    }
    if (query.ownerTaskId !== undefined) {
      clauses.push(`owner_task_id = ${bind(params, query.ownerTaskId)}`);
    }
    params.push(limit + 1);
    const rows = await this.db.query(
      `SELECT record FROM conversations WHERE ${clauses.join(" AND ")} ORDER BY id ${orderSql(position.order)} LIMIT $${params.length}`,
      params,
    );
    return page(rows.map((row) => parseJson(row.record) as ConversationRecord), limit, position.order);
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    idOrConversationId: number,
    idOrContext?: EntryId | Context,
    context?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    this.assertOpen();
    return this.db.readTransaction((tx) => this.readEntry(tx, idOrConversationId, idOrContext, context));
  }

  private async readEntry(
    tx: PostgresExecutor,
    idOrConversationId: number,
    idOrContext?: EntryId | Context,
    context?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    const id: EntryId | undefined =
      context === undefined
        ? asEntryId(idOrConversationId)
        : typeof idOrContext === "number"
          ? asEntryId(idOrContext)
          : undefined;
    if (id === undefined) throw new TypeError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      const conversationId = asConversationId(idOrConversationId);
      conversation = await this.readConversation(tx, conversationId);
      if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    }
    const rows = await tx.query("SELECT record, commit_seq FROM entries WHERE id = $1", [id]);
    if (rows.length === 0) return undefined;
    const entry = parseJson(rows[0]!.record) as EntryRecord;
    if (conversation !== undefined) {
      let current: ConversationRecord = conversation;
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (current.id !== entry.conversationId) {
        if (current.parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, current.parent.at);
        current = (await this.readConversation(tx, current.parent.conversationId))!;
      }
      if (entry.id > upperEntryId) return undefined;
    }
    return { entry, commitSeq: asSeq(rows[0]!.commit_seq as number) };
  }

  async findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    this.assertOpen();
    return this.db.readTransaction(async (tx) => {
      let current = await this.readConversation(tx, conversationId);
      if (current === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
      let upper: number | undefined = atOrBeforeEntryId;
      while (true) {
        const rows =
          upper === undefined
            ? await tx.query(
                "SELECT record FROM entries WHERE conversation_id = $1 AND head IS NOT NULL ORDER BY id DESC LIMIT 1",
                [current.id],
              )
            : await tx.query(
                "SELECT record FROM entries WHERE conversation_id = $1 AND head IS NOT NULL AND id <= $2 ORDER BY id DESC LIMIT 1",
                [current.id, upper],
              );
        if (rows.length > 0) return parseJson(rows[0]!.record) as EntryRecord & { head: EntryId };
        if (current.parent === undefined) return undefined;
        upper = upper === undefined ? current.parent.at : Math.min(upper, current.parent.at);
        current = (await this.readConversation(tx, current.parent.conversationId))!;
      }
    });
  }

  async scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    this.assertOpen();
    return this.db.readTransaction((tx) => this.readEntries(tx, query, limit, cursor));
  }

  private async readEntries(
    tx: PostgresExecutor,
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
  ): Promise<Page<EntryRecord, Cursor>> {
    const position = resolveCursor(cursor, query.order, "descending", "entry scan");
    const segments = await this.entrySegments(tx, query.conversationId, query.maxEntryId);
    // Ascending walks the fork chain root first, each segment capped at the
    // next fork point; descending walks it leaf first.
    const ordered = position.order === "ascending" ? [...segments].reverse() : segments;
    const afterClause = (params: unknown[]): string | undefined => {
      if (position.after === undefined) return undefined;
      return position.order === "ascending"
        ? idClause(">", bind(params, position.after))
        : idClause("<", bind(params, position.after));
    };
    const values: EntryRecord[] = [];
    for (const segment of ordered) {
      const params: unknown[] = [segment.conversationId];
      const clauses = ["conversation_id = $1"];
      if (segment.cap !== undefined) clauses.push(`id <= ${bind(params, segment.cap)}`);
      if (query.minEntryId !== undefined) clauses.push(`id >= ${bind(params, query.minEntryId)}`);
      const after = afterClause(params);
      if (after !== undefined) clauses.push(after);
      params.push(limit + 1 - values.length);
      const rows = await tx.query(
        `SELECT record FROM entries WHERE ${clauses.join(" AND ")} ORDER BY id ${orderSql(position.order)} LIMIT $${params.length}`,
        params,
      );
      values.push(...rows.map((row) => parseJson(row.record) as EntryRecord));
      if (values.length > limit) break;
    }
    return page(values, limit, position.order);
  }

  /** The fork chain of one conversation, leaf first: each ancestor's
   *  segment is capped at the fork point on the path below it. */
  private async entrySegments(
    tx: PostgresExecutor,
    conversationId: ConversationId,
    maxEntryId: EntryId | undefined,
  ): Promise<{ conversationId: ConversationId; cap: number | undefined }[]> {
    let conversation = await this.readConversation(tx, conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    const segments: { conversationId: ConversationId; cap: number | undefined }[] = [];
    let cap: number | undefined = maxEntryId;
    while (true) {
      segments.push({ conversationId: conversation.id, cap });
      if (conversation.parent === undefined) break;
      cap = cap === undefined ? conversation.parent.at : Math.min(cap, conversation.parent.at);
      conversation = (await this.readConversation(tx, conversation.parent.conversationId))!;
    }
    return segments;
  }

  async task(id: TaskId, _context: Context): Promise<TaskRecord<JsonObject, JsonObject, JsonObject> | undefined> {
    this.assertOpen();
    const rows = await this.db.query("SELECT record FROM tasks WHERE id = $1", [id]);
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as TaskRecord<JsonObject, JsonObject, JsonObject>);
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<TaskRecord<JsonObject, JsonObject, JsonObject>, Cursor>> {
    this.assertOpen();
    const position = resolveCursor(cursor, query.order, "ascending", "task scan");
    const start = scanStart(position, -1);
    const params = [...start.params];
    const clauses = [start.clause];
    if (query.conversationId !== undefined) {
      clauses.push(`conversation_id = ${bind(params, query.conversationId)}`);
    }
    if (query.kind !== undefined) {
      clauses.push(`kind = ${bind(params, encodeIndexedString(query.kind))}`);
    }
    if (query.status !== undefined) {
      clauses.push(`status = ${bind(params, query.status)}`);
    }
    if (query.abortRequested !== undefined) {
      clauses.push(`abort_requested = ${bind(params, query.abortRequested)}`);
    }
    if (query.background !== undefined) {
      clauses.push(`background = ${bind(params, query.background)}`);
    }
    params.push(limit + 1);
    const rows = await this.db.query(
      `SELECT record FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY id ${orderSql(position.order)} LIMIT $${params.length}`,
      params,
    );
    return page(rows.map((row) => parseJson(row.record) as TaskRecord<JsonObject, JsonObject, JsonObject>), limit, position.order);
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    this.assertOpen();
    const rows = await this.db.query("SELECT record FROM submissions WHERE id = $1", [id]);
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as SubmissionRecord);
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    this.assertOpen();
    const position = resolveCursor(cursor, query.order, "ascending", "submission scan");
    const start = scanStart(position, -1);
    const params = [...start.params];
    const clauses = [start.clause];
    if (query.conversationId !== undefined) {
      clauses.push(`conversation_id = ${bind(params, query.conversationId)}`);
    }
    if (query.status !== undefined) {
      clauses.push(`status = ${bind(params, query.status)}`);
    }
    params.push(limit + 1);
    const rows = await this.db.query(
      `SELECT record FROM submissions WHERE ${clauses.join(" AND ")} ORDER BY id ${orderSql(position.order)} LIMIT $${params.length}`,
      params,
    );
    return page(rows.map((row) => parseJson(row.record) as SubmissionRecord), limit, position.order);
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    this.assertOpen();
    const rows = await this.db.query(
      "SELECT record FROM submissions WHERE conversation_id = $1 AND request_id = $2",
      [conversationId, encodeIndexedString(requestId)],
    );
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as SubmissionRecord);
  }

  async findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    this.assertOpen();
    const parts = addressParts(address);
    const params: unknown[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
    const sql =
      at === "current"
        ? `SELECT record FROM documents
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5
				AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
        : `SELECT record FROM documents
				WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5
				AND created_at <= $6 AND (retired_at IS NULL OR retired_at > $7)
				ORDER BY created_at DESC LIMIT 1`;
    if (at !== "current") params.push(at, at);
    const rows = await this.db.query(sql, params);
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as DocumentRecord);
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    this.assertOpen();
    // Record and revision queries must observe one committed state; a commit between
    // them could otherwise replace the base mid-read.
    return this.db.readTransaction(async (tx) => {
      const stored = await this.materializeDocument(tx, id, at);
      if (at === "current" && stored?.record.kind === "pi.live" && !this.liveRevisions.has(id)) {
        const rows = await tx.query<{ seq: number }>("SELECT max(seq) AS seq FROM document_revisions WHERE document_id=$1", [id]);
        this.liveRevisions.set(id, Number(rows[0]!.seq));
        this.liveValues.set(id, structuredClone(stored.value));
      }
      return stored;
    });
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    this.assertOpen();
    const scope = scopeColumns(query.scope);
    const params: unknown[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
    const clauses = ["scope_kind = $1", "owner_id = $2", "id > $3"];
    if (query.kind !== undefined) {
      clauses.push(`kind = ${bind(params, encodeIndexedString(query.kind))}`);
    }
    if (query.at === "current") {
      clauses.push("retired_at IS NULL");
    } else {
      clauses.push(`created_at <= ${bind(params, query.at)}`);
      clauses.push(`(retired_at IS NULL OR retired_at > ${bind(params, query.at)})`);
    }
    params.push(limit + 1);
    const rows = await this.db.query(
      `SELECT record FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT $${params.length}`,
      params,
    );
    return page(rows.map((row) => parseJson(row.record) as DocumentRecord), limit, "ascending");
  }

  async close(_context: Context): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = this.db.close();
    }
    await this.closing;
  }

  private async readConversation(tx: PostgresExecutor, id: ConversationId): Promise<ConversationRecord | undefined> {
    const rows = await tx.query("SELECT record FROM conversations WHERE id = $1", [id]);
    return rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as ConversationRecord);
  }

  private async materializeDocument(
    tx: PostgresExecutor,
    id: DocumentId,
    at: DocumentPoint,
  ): Promise<StoredDocument | undefined> {
    const rows = await tx.query("SELECT record FROM documents WHERE id = $1", [id]);
    if (rows.length === 0) return undefined;
    const record = parseJson(rows[0]!.record) as DocumentRecord;
    if (at !== "current" && isCurrentOnly(record)) {
      throw new StorageRequestError(`Document ${id} does not retain historical content`);
    }
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    const baseRows = await tx.query<{ seq: number; version: number; content: string }>(
      `SELECT seq, version, content FROM document_revisions
			WHERE document_id = $1 AND kind = 'base' AND seq <= $2 ORDER BY seq DESC LIMIT 1`,
      [id, upper],
    );
    if (baseRows.length === 0) throw new Error(`Document ${id} is missing a required base`);
    const base = baseRows[0]!;
    let value = parseJson(base.content) as JsonObject;
    const tailRows = await tx.query<{ kind: string; version: number; content: string }>(
      `SELECT kind, version, content FROM document_revisions
			WHERE document_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`,
      [id, base.seq, upper],
    );
    for (const revision of tailRows) {
      if (revision.kind !== "delta" || revision.version !== base.version) {
        throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      }
      value = apply(value, parseJson(revision.content) as readonly Op[]);
    }
    return { record, version: base.version, value, deltasSinceBase: tailRows.length };
  }

  private candidateNextId(writes: readonly StorageWrite[]): number {
    let nextId = this.nextId;
    for (const write of writes) {
      const id = writeId(write);
      if (id !== undefined) nextId = Math.max(nextId, id + 1);
    }
    return nextId;
  }

  private async checkGlobalIds(tx: PostgresExecutor, writes: readonly StorageWrite[]): Promise<void> {
    const claimed = new Map<number, string>();
    for (const write of writes) {
      if (write.type === "document.change" || write.type === "document.retire") continue;
      const document = write.type === "document.create" || write.type === "document.copy";
      const table = document ? "document" : write.type;
      const id = document ? write.record.id : write.value.id;
      const existingRows = await tx.query<{ record_type: string }>("SELECT record_type FROM record_ids WHERE id = $1", [id]);
      const existing = existingRows.length === 0 ? undefined : existingRows[0]!.record_type;
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
    const actions = new Map<DocumentId, DocumentAction>();
    for (const write of writes) {
      if (
        write.type !== "document.create" &&
        write.type !== "document.copy" &&
        write.type !== "document.change" &&
        write.type !== "document.retire"
      ) {
        continue;
      }
      const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
      let action = actions.get(id);
      if (action === undefined) {
        action = { retire: false };
        actions.set(id, action);
      }
      switch (write.type) {
        case "document.create":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.create = write.record;
          action.content = write.content;
          break;
        case "document.copy":
          if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.create = write.record;
          action.copy = write.source;
          break;
        case "document.change":
          if (action.content !== undefined || action.copy !== undefined) {
            throw new Error(`Document ${id} has more than one content command`);
          }
          action.content = write.content;
          break;
        case "document.retire":
          if (action.retire) throw new Error(`Document ${id} is retired more than once`);
          action.retire = true;
          break;
      }
    }
    return actions;
  }

  private async checkDocumentActions(tx: PostgresExecutor, actions: Map<DocumentId, DocumentAction>): Promise<void> {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) {
        throw new Error(`Document copy ${id} source is changed in the copy batch`);
      }
      const rows = await tx.query("SELECT record FROM documents WHERE id = $1", [id]);
      const existing = rows.length === 0 ? undefined : (parseJson(rows[0]!.record) as DocumentRecord);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = await tx.query<{ version: number }>(
          "SELECT version FROM document_revisions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1",
          [id],
        );
        if (previous.length === 0) throw new Error(`Document ${id} delta has no base`);
        if (previous[0]!.version !== action.content.version) {
          throw new Error(`Document ${id} version transition requires a base`);
        }
      }
      const record = action.create ?? existing!;
      if (record.kind === "pi.live" && existing && (action.content || action.retire)) {
        const rows = await tx.query<{ seq: number }>("SELECT max(seq) AS seq FROM document_revisions WHERE document_id=$1", [id]);
        const expected = this.liveRevisions.get(id);
        if (expected !== undefined && expected !== Number(rows[0]!.seq)) {
          throw new StorageRequestError(`Live projection ${id} has a stale writer`);
        }
        if (action.content?.kind === "delta") {
          // A matching revision lets validation reuse the committed value rather
          // than replay the growing delta chain on every streaming update.
          const value = this.liveValues.get(id) ?? (await this.materializeDocument(tx, id, "current"))!.value;
          action.liveValue = applyImmutable(value, action.content.ops);
        } else if (action.content?.kind === "base") {
          action.liveValue = action.content.value;
        }
      }
      const key = addressKey(record);
      let live = liveCounts.get(key);
      if (live === undefined) live = (await this.currentDocumentId(tx, record)) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }

  private async currentDocumentId(
    tx: PostgresExecutor,
    record: DocumentCreate | DocumentRecord,
  ): Promise<DocumentId | undefined> {
    const parts = addressParts({ kind: record.kind, scope: record.scope, key: record.key });
    const rows = await tx.query<{ id: number }>(
      `SELECT id FROM documents
			WHERE kind = $1 AND scope_kind = $2 AND owner_id = $3 AND family = $4 AND key_value = $5 AND retired_at IS NULL
			LIMIT 1`,
      [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue],
    );
    return rows.length === 0 ? undefined : asDocumentId(rows[0]!.id);
  }

  private async claimId(tx: PostgresExecutor, id: number, table: string): Promise<void> {
    await tx.query("INSERT INTO record_ids (id, record_type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, table]);
  }

  private async applyTableWrite(tx: PostgresExecutor, write: StorageWrite, seq: Seq): Promise<void> {
    switch (write.type) {
      case "conversation":
        await this.claimId(tx, write.value.id, "conversation");
        await tx.query(
          "INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES ($1, $2, $3, $4)",
          [
            write.value.id,
            write.value.owner?.conversationId ?? null,
            write.value.owner?.taskId ?? null,
            encodeJson(write.value),
          ],
        );
        break;
      case "entry":
        await this.claimId(tx, write.value.id, "entry");
        await tx.query(
          "INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES ($1, $2, $3, $4, $5)",
          [write.value.id, write.value.conversationId, write.value.head ?? null, seq, encodeJson(write.value)],
        );
        break;
      case "task":
        await this.claimId(tx, write.value.id, "task");
        await tx.query(
          `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
					VALUES ($1, $2, $3, $4, $5, $6, $7)
					ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
					status = excluded.status, abort_requested = excluded.abort_requested,
					background = excluded.background, record = excluded.record`,
          [
            write.value.id,
            write.value.conversationId,
            encodeIndexedString(write.value.kind),
            write.value.state.status,
            write.value.abortRequested,
            write.value.background,
            encodeJson(write.value),
          ],
        );
        break;
      case "submission":
        await this.claimId(tx, write.value.id, "submission");
        await tx.query(
          `INSERT INTO submissions (id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, $4, $5)
					ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id,
					request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
          [
            write.value.id,
            write.value.conversationId,
            write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
            write.value.status,
            encodeJson(write.value),
          ],
        );
        break;
      case "document.create":
      case "document.copy":
      case "document.change":
      case "document.retire":
        break;
    }
  }

  private async applyDocumentActions(
    tx: PostgresExecutor,
    actions: Map<DocumentId, DocumentAction>,
    seq: Seq,
  ): Promise<void> {
    for (const [id, action] of actions) {
      let content = action.content;
      if (action.copy !== undefined) {
        try {
          const stored = await this.materializeDocument(tx, action.copy.id, action.copy.at);
          if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
          const create = action.create;
          if (create === undefined) {
            throw new Error(`Document copy ${id} has no creation record`);
          }
          if (
            stored.record.scope.kind !== "conversation" ||
            create.scope.kind !== "conversation" ||
            stored.record.kind !== create.kind ||
            stored.record.key !== create.key ||
            stored.record.history !== create.history ||
            stored.record.fork !== create.fork
          ) {
            throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
          }
          content = { kind: "base", version: stored.version, value: stored.value };
        } catch (error) {
          throw new Error(`Document copy ${id} was rejected`, { cause: error });
        }
      }
      let record: DocumentRecord;
      if (action.create !== undefined) {
        record = {
          ...action.create,
          createdAt: seq,
          ...(action.retire ? { retiredAt: seq } : {}),
        } as DocumentRecord;
        const parts = addressParts({ kind: record.kind, scope: record.scope, key: record.key });
        await this.claimId(tx, id, "document");
        await tx.query(
          `INSERT INTO documents
					(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            parts.kind,
            parts.family,
            parts.keyValue,
            parts.scopeKind,
            parts.ownerId,
            seq,
            action.retire ? seq : null,
            encodeJson(record),
          ],
        );
      } else {
        const rows = await tx.query("SELECT record FROM documents WHERE id = $1", [id]);
        record = parseJson(rows[0]!.record) as DocumentRecord;
      }
      if (content !== undefined) {
        if (content.kind === "base" && isCurrentOnly(record)) {
          await tx.query("DELETE FROM document_revisions WHERE document_id = $1", [id]);
        }
        await tx.query(
          "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES ($1, $2, $3, $4, $5)",
          [
            id,
            seq,
            content.kind,
            content.version,
            encodeJson(content.kind === "base" ? content.value : content.ops),
          ],
        );
      }
      if (action.retire) {
        if (action.create === undefined) {
          record = { ...record, retiredAt: seq };
          await tx.query("UPDATE documents SET retired_at = $1, record = $2 WHERE id = $3", [
            seq,
            encodeJson(record),
            id,
          ]);
        }
        if (isCurrentOnly(record)) {
          await tx.query("DELETE FROM document_revisions WHERE document_id = $1", [id]);
        }
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgresDurableStorage is closed");
  }
}
