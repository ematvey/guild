import type { PostgresDatabase } from "./executor.js";

/**
 * Durable_* tables live in the same database as the platform tables
 * (design decision 5): durable_metadata, record_ids, conversations, entries,
 * tasks, submissions, documents, document_revisions.
 *
 * Record and revision columns are JSON text, not JSONB: Postgres JSONB
 * rejects lone-surrogate Unicode escapes, and record identity must round-trip
 * losslessly (the pinned SQLite reference stores JSON text for the same
 * reason).
 *
 * No cross-table foreign keys: the storage contract fixes a global ID
 * namespace (record_ids) and permits writes of one batch in any order, so
 * physical insert order carries no semantic guarantee.
 */
const INITIAL_SCHEMA = [
  `CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id BIGINT NOT NULL,
		next_seq BIGINT NOT NULL
	)`,
  `INSERT INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, 2, 1)
		ON CONFLICT (singleton) DO NOTHING`,
  `CREATE TABLE record_ids (
		id BIGINT PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	)`,
  `CREATE TABLE conversations (
		id BIGINT PRIMARY KEY,
		owner_conversation_id BIGINT,
		owner_task_id BIGINT,
		record TEXT NOT NULL
	)`,
  "CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id)",
  "CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id)",
  `CREATE TABLE entries (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		head BIGINT,
		commit_seq BIGINT NOT NULL,
		record TEXT NOT NULL
	)`,
  "CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC)",
  "CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL",
  `CREATE TABLE tasks (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested BOOLEAN NOT NULL,
		background BOOLEAN NOT NULL,
		record TEXT NOT NULL
	)`,
  "CREATE INDEX tasks_by_status ON tasks (status, id)",
  "CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id)",
  "CREATE INDEX tasks_by_kind ON tasks (kind, id)",
  "CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id)",
  "CREATE INDEX tasks_by_background ON tasks (background, id)",
  `CREATE TABLE submissions (
		id BIGINT PRIMARY KEY,
		conversation_id BIGINT NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL
	)`,
  "CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id)",
  "CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id)",
  "CREATE INDEX submissions_by_status ON submissions (status, id)",
  `CREATE TABLE documents (
		id BIGINT PRIMARY KEY,
		kind TEXT NOT NULL,
		family BOOLEAN NOT NULL,
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id BIGINT NOT NULL,
		created_at BIGINT NOT NULL,
		retired_at BIGINT,
		record TEXT NOT NULL
	)`,
  `CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
  "CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id)",
  "CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id)",
  `CREATE TABLE document_revisions (
		document_id BIGINT NOT NULL,
		seq BIGINT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL,
		PRIMARY KEY (document_id, seq)
	)`,
  "CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC)",
];

/** Immutable, ordered schema history. Append new migrations after the initial schema ships. */
export const DURABLE_POSTGRES_MIGRATIONS = [{ version: 1, statements: INITIAL_SCHEMA }];

export const CURRENT_POSTGRES_SCHEMA_VERSION = DURABLE_POSTGRES_MIGRATIONS.at(-1)?.version ?? 0;

/** Apply all pending schema migrations atomically; idempotent across reopen. */
export async function applyPostgresMigrations(
  database: PostgresDatabase,
  migrations = DURABLE_POSTGRES_MIGRATIONS,
): Promise<void> {
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index]?.version !== index + 1) {
      throw new Error("Durable Postgres migrations must have contiguous versions starting at 1");
    }
  }
  await database.transaction(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		)`);
    await tx.query(
      "INSERT INTO durable_schema (singleton, version) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING",
    );
    const rows = await tx.query<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1");
    if (rows.length === 0) throw new Error("Durable Postgres schema metadata is missing");
    const currentVersion = migrations.at(-1)?.version ?? 0;
    const appliedVersion = rows[0]!.version;
    if (appliedVersion > currentVersion) {
      throw new Error(`Durable Postgres schema version ${appliedVersion} is newer than supported version ${currentVersion}`);
    }
    for (const migration of migrations) {
      if (migration.version <= appliedVersion) continue;
      for (const statement of migration.statements) await tx.query(statement);
      await tx.query("UPDATE durable_schema SET version = $1 WHERE singleton = 1", [migration.version]);
    }
  });
}
