// Durable coordination, provenance and maintenance records. SQL stays in the Agent data-access lane.
import type { QueryResultRow } from "pg";
import type { PlatformPool, PoolClient } from "../../platform/db.js";
type Database = PlatformPool | PoolClient;

export function readMemoryRevision<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT hash FROM agent_memory_reads WHERE thread_id=$1 AND path=$2`, values);
}

export function recordMemoryRevision<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `INSERT INTO agent_memory_reads(thread_id,path,hash) VALUES($1,$2,$3) ON CONFLICT(thread_id,path) DO UPDATE SET hash=EXCLUDED.hash`,
    values,
  );
}

export function findCoordinationThread<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT id FROM agent_threads WHERE agent_id = $1 AND execution_role = $2 AND ($2 = 'coordinator' OR user_id = $3)`,
    values,
  );
}

export function readCoordinationRole<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT t.execution_role, t.coordinator_managed, t.source_input_id,
            t.coordinator_managed AND p.agent_id = t.agent_id AS general_worker
     FROM agent_threads t LEFT JOIN agent_threads p ON p.id = t.parent_thread_id WHERE t.chat_id = $1`,
    values,
  );
}

export function retryCoordinationInput<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_inputs SET lease_until = now() + interval '5 seconds' WHERE id = $1`,
    values,
  );
}

export function claimCoordinationInputs<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `WITH due AS (
        SELECT i.id FROM agent_coordination_inputs i JOIN agents a ON a.id = i.agent_id
        WHERE i.delivered_at IS NULL AND i.due_at <= now() AND (i.lease_until IS NULL OR i.lease_until < now())
          AND a.status = 'active' AND COALESCE(CASE WHEN jsonb_typeof(a.resources #> '{assistant,enabled}')='boolean' THEN (a.resources #>> '{assistant,enabled}')::boolean END, a.is_personal)
        ORDER BY i.seq LIMIT 40 FOR UPDATE OF i SKIP LOCKED
      ), claimed AS (
        UPDATE agent_coordination_inputs i SET lease_until = now() + interval '2 minutes'
        FROM due WHERE i.id = due.id RETURNING i.*
      )
      SELECT c.*, COALESCE(u.display_name,u.email) AS name,u.email, provenance.routine_id, provenance.occurrence_id,
        COALESCE(event.payload->'attachments', '[]'::jsonb) AS attachments
      FROM claimed c JOIN users u ON u.id=c.user_id
      LEFT JOIN agent_threads source ON source.id=c.source_thread_id
      LEFT JOIN thread_events event ON event.id=c.source_event_id AND event.chat_id=source.chat_id
        AND event.type='user_message' AND c.kind='request'
      LEFT JOIN LATERAL (
        SELECT r.routine_id, o.id AS occurrence_id
        FROM agent_runs r LEFT JOIN agent_routine_occurrences o ON o.run_id=r.id
        WHERE c.kind='routine' AND r.thread_id=c.source_thread_id AND r.routine_id IS NOT NULL
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      ) provenance ON true ORDER BY c.seq`,
    values,
  );
}

export function deliverCoordinationInput<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_inputs SET delivered_at = now(), lease_until = NULL WHERE id = $1`,
    values,
  );
}

export function initializeCoordinationState<T extends QueryResultRow = QueryResultRow>(
  db: Database,
  values: unknown[],
) {
  return db.query<T>(
    `INSERT INTO agent_coordination_state(agent_id,reflection_started_at) SELECT agent_id,now() FROM agent_threads WHERE execution_role='coordinator' ON CONFLICT DO NOTHING`,
    values,
  );
}

export function listCoordinators<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT agent_id,chat_id FROM agent_threads WHERE execution_role='coordinator' ORDER BY agent_id`,
    values,
  );
}

export function readCoordinationState<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT reflection_thread_id,reflection_inputs,
           extract(epoch FROM now()-reflection_started_at)::float AS reflection_age
           FROM agent_coordination_state WHERE agent_id=$1`,
    values,
  );
}

export function readReflectionStatus<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT status FROM agent_runs WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 1`, values);
}

export function markInputsReflected<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`UPDATE agent_coordination_inputs SET reflected_at=now() WHERE id=ANY($1::uuid[])`, values);
}

export function clearReflection<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_state SET reflection_thread_id=NULL,reflection_inputs='{}' WHERE agent_id=$1`,
    values,
  );
}

export function pendingReflectionInputs<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT id,seq,content,kind,count(*) OVER () AS pending_count
     FROM agent_coordination_inputs WHERE agent_id=$1 AND delivered_at IS NOT NULL AND reflected_at IS NULL
     ORDER BY seq LIMIT 50`,
    values,
  );
}

/** Keep reference IDs for replay and clear payloads in bounded batches. */
export function expireReflectedInputContent(db: Database) {
  return db.query(`WITH expired AS (
    SELECT id FROM agent_coordination_inputs
    WHERE reflected_at < now() - interval '30 days' AND content <> ''
    ORDER BY reflected_at,id LIMIT 200 FOR UPDATE SKIP LOCKED
  )
  UPDATE agent_coordination_inputs i SET content='' FROM expired WHERE i.id=expired.id`);
}

export function startReflection<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_state SET reflection_thread_id=$2,reflection_inputs=$3,reflection_started_at=now() WHERE agent_id=$1`,
    values,
  );
}

export function resetReflection<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_state SET reflection_thread_id=NULL,reflection_inputs='{}' WHERE agent_id=$1`,
    values,
  );
}

export function readCoordinationSource<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT id,user_id,source_thread_id,kind FROM agent_coordination_inputs WHERE id=$1 AND agent_id=$2`,
    values,
  );
}

export function queueCoordinationReply(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs SET reply_text=$3, reply_due_at=now()
     WHERE id=$1 AND agent_id=$2 AND kind='request' AND source_thread_id IS NOT NULL
       AND reply_due_at IS NULL`,
    values,
  );
}

export function claimCoordinationReplies<T extends QueryResultRow>(db: Database) {
  return db.query<T>(
    `WITH due AS (
       SELECT id FROM agent_coordination_inputs
       WHERE reply_due_at <= now() AND reply_delivered_at IS NULL AND reply_failed_at IS NULL
       ORDER BY reply_due_at,seq LIMIT 16 FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_coordination_inputs i SET reply_due_at=now()+interval '30 seconds'
     FROM due WHERE i.id=due.id
     RETURNING i.id,i.agent_id,i.user_id,i.source_thread_id,i.reply_text`,
  );
}

export function settleCoordinationReply(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs
     SET reply_text=NULL, reply_delivered_at=CASE WHEN $2::boolean THEN now() END,
         reply_failed_at=CASE WHEN NOT $2::boolean THEN now() END
     WHERE id=$1 AND reply_delivered_at IS NULL AND reply_failed_at IS NULL`,
    values,
  );
}

export function isInternalChat<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT 1 FROM chats WHERE id=$1 AND internal`, values);
}

export function insertCoordinatorWake<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `INSERT INTO agent_coordination_inputs(id,agent_id,user_id,source_thread_id,kind,content,wake,due_at)
          VALUES($1,$2,$3,$4,'wake',$5,true,$6) ON CONFLICT (id) DO NOTHING`,
    values,
  );
}

export function listCoordinatorWakes<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT id,due_at,content FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='wake' AND delivered_at IS NULL ORDER BY due_at LIMIT 100`,
    values,
  );
}

export function cancelCoordinatorWake<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `DELETE FROM agent_coordination_inputs WHERE id=$1 AND agent_id=$2 AND kind='wake' AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until <= now())`,
    values,
  );
}

export function listCoordinationThreads<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT id,chat_id,user_id,title,type FROM agent_threads WHERE agent_id=$1 ORDER BY last_activity_at DESC LIMIT 100`,
    values,
  );
}

export function coordinatorAgentForChat<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT agent_id FROM agent_threads WHERE chat_id=$1 AND execution_role='coordinator'`, values);
}

export function readWorkerCoordination<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT coordinator_managed,source_input_id FROM agent_threads WHERE id=$1`, values);
}

export function isRoutineChat<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT 1 FROM agent_threads WHERE chat_id=$1 AND type='routine'`, values);
}

export function readIntegrationAgentIdentity<T extends QueryResultRow = QueryResultRow>(
  db: Database,
  values: unknown[],
) {
  return db.query<T>(
    `SELECT a.is_personal FROM agent_threads t JOIN agents a ON a.id=t.agent_id WHERE t.chat_id=$1`,
    values,
  );
}

export function readIntegrationAgentScope<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT a.resources,a.is_personal,a.model,t.user_id,a.org_id FROM agent_threads t JOIN agents a ON a.id=t.agent_id WHERE t.chat_id=$1`,
    values,
  );
}

export function readWorkerOrigin<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT i.id,i.user_id,i.source_thread_id,i.source_event_id,u.email,COALESCE(u.display_name,u.email) AS name
       FROM agent_threads t JOIN agent_coordination_inputs i ON i.id=t.source_input_id
       JOIN users u ON u.id=i.user_id WHERE t.id=$1`,
    values,
  );
}

export function recordWorkerOutcome<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `INSERT INTO agent_coordination_inputs(agent_id,user_id,source_thread_id,source_event_id,kind,content,wake,delivered_at)
      SELECT agent_id,$2,$3,$4,'worker_result',$5,false,now() FROM agent_threads WHERE chat_id=$1
      ON CONFLICT (source_event_id) DO NOTHING`,
    values,
  );
}
