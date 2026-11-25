// Durable coordination, provenance and maintenance records. SQL stays in the Agent data-access lane.
import type { CoordinationOutcome, CoordinationSnapshot } from "@guild/wire/rest";
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
    `UPDATE agent_coordination_inputs SET lease_until = now() + interval '5 seconds'
     WHERE id=$1 AND evaluation_request_id IS NOT DISTINCT FROM $2::uuid`,
    values,
  );
}

export function claimCoordinationInputs<T extends QueryResultRow = QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `WITH due AS (
        SELECT i.id FROM agent_coordination_inputs i JOIN agents a ON a.id = i.agent_id
        WHERE i.delivered_at IS NULL AND i.due_at <= now() AND (i.lease_until IS NULL OR i.lease_until < now())
          AND (i.kind <> 'candidate' OR NOT EXISTS (
            SELECT 1 FROM agent_coordination_state s WHERE s.agent_id=i.agent_id AND s.paused_at IS NOT NULL))
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
    `UPDATE agent_coordination_inputs SET delivered_at = now(), lease_until = NULL
     WHERE id=$1 AND evaluation_request_id IS NOT DISTINCT FROM $2::uuid`,
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
     FROM agent_coordination_inputs WHERE agent_id=$1 AND delivered_at IS NOT NULL AND reflected_at IS NULL AND kind<>'candidate'
     ORDER BY seq LIMIT 50`,
    values,
  );
}

/** Keep reference IDs for replay and clear payloads in bounded batches. */
export function expireReflectedInputContent(db: Database) {
  return db.query(`WITH expired AS (
    SELECT id FROM agent_coordination_inputs
    WHERE (reflected_at < now() - interval '30 days'
      OR (kind='candidate' AND decision IS NOT NULL AND created_at < now() - interval '30 days'))
      AND content <> ''
      AND NOT (attached_thread_id IS NOT NULL AND launch_error IS NULL AND launched_run_id IS NULL)
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
    `SELECT id,user_id,source_thread_id,kind,source_name FROM agent_coordination_inputs WHERE id=$1 AND agent_id=$2`,
    values,
  );
}

export function captureCoordinationSource<T extends QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `INSERT INTO agent_coordination_inputs(
       agent_id,user_id,source_thread_id,kind,content,source_name,source_key,source_policy,wake,delivered_at,
       decision,decision_reason)
     VALUES($1,$2,$3,'candidate',$4,$5,$6,$7,$8,
       CASE WHEN NOT $8::boolean THEN now() END,
       CASE WHEN NOT $8::boolean THEN 'ignored' END,
       CASE WHEN NOT $8::boolean THEN $9 END)
     ON CONFLICT (agent_id,source_name,source_key) WHERE source_name IS NOT NULL
       DO UPDATE SET source_key=EXCLUDED.source_key
     RETURNING id,decision`,
    values,
  );
}

export function recordCoordinationDecision<T extends QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `UPDATE agent_coordination_inputs i
     SET decision=$3,decision_reason=$4,matched_rule=$5,
         accepted_scope=$6,accepted_agent_id=$7,accepted_parent_run_id=$8,
         launch_due_at=CASE WHEN $3='accepted' THEN now() END
     FROM agents a
     WHERE i.id=$1 AND i.agent_id=$2 AND i.kind='candidate' AND i.decision IS NULL
       AND COALESCE(i.evaluation_request_id,i.id)=ANY($9::uuid[])
       AND a.id=i.agent_id AND i.source_policy=COALESCE(a.resources #> '{assistant,admission}', '{}'::jsonb)
     RETURNING decision`,
    values,
  );
}

export function coordinationLaunchPolicy(db: Database, values: unknown[]) {
  return db.query(
    `SELECT 1 FROM agent_coordination_inputs i JOIN agents a ON a.id=i.agent_id
     WHERE i.id=$1 AND i.source_policy=a.resources #> '{assistant,admission}' AND i.source_policy->>'mode'='auto'`,
    values,
  );
}

export function settleUnansweredCoordinationCandidates(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs i SET decision='unavailable', decision_reason='No current admission decision'
     FROM agent_threads t WHERE t.chat_id=$1 AND t.execution_role='coordinator' AND i.agent_id=t.agent_id
       AND COALESCE(i.evaluation_request_id,i.id)=ANY($2::uuid[]) AND i.kind='candidate' AND i.decision IS NULL`,
    values,
  );
}

export function hasCoordinationCandidates(db: Database, values: unknown[]) {
  return db.query(
    `SELECT 1 FROM agent_coordination_inputs i JOIN agent_threads t ON t.agent_id=i.agent_id
     WHERE t.chat_id=$1 AND t.execution_role='coordinator' AND i.kind='candidate'
       AND COALESCE(i.evaluation_request_id,i.id)=ANY($2::uuid[]) LIMIT 1`,
    values,
  );
}

export function activeCoordinationInput(db: Database, values: unknown[]) {
  return db.query(
    `SELECT 1 FROM agent_coordination_inputs WHERE id=$1 AND agent_id=$2
       AND COALESCE(evaluation_request_id,id)=ANY($3::uuid[])`,
    values,
  );
}

export function setCoordinationPaused(db: Database, values: unknown[]) {
  return db.query(
    `INSERT INTO agent_coordination_state(agent_id,paused_at,reflection_started_at)
     VALUES($1,CASE WHEN $2::boolean THEN now() END,now())
     ON CONFLICT (agent_id) DO UPDATE SET
       paused_at=CASE WHEN $2::boolean THEN COALESCE(agent_coordination_state.paused_at,now()) END`,
    values,
  );
}

export function coordinationPaused<T extends QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(`SELECT paused_at FROM agent_coordination_state WHERE agent_id=$1`, values);
}

export function reevaluateSourceCandidate(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs i SET decision=NULL,decision_reason=NULL,matched_rule=NULL,
       source_policy=$4,evaluation_request_id=gen_random_uuid(),source_thread_id=COALESCE(i.source_thread_id,$5),
       wake=true,delivered_at=NULL,due_at=now(),lease_until=NULL,reflected_at=NULL
     FROM agents a WHERE i.id=$1 AND i.agent_id=$2 AND i.user_id=$3 AND a.id=i.agent_id
       AND i.kind='candidate' AND i.decision IN ('ignored','would_accept','unavailable')
       AND i.content<>'' AND ($4::jsonb->'sources') ? i.source_name
       AND $4::jsonb=a.resources #> '{assistant,admission}'`,
    values,
  );
}

export async function coordinationSnapshot(db: Database, agentId: string, viewerId: string, admin: boolean): Promise<CoordinationSnapshot> {
  const [outcomes, paused] = await Promise.all([
    listCoordinationOutcomes(db, [agentId, viewerId, admin]),
    coordinationPaused<{ paused_at: Date | null }>(db, [agentId]),
  ]);
  return { paused: paused.rows[0]?.paused_at != null, outcomes: outcomes.rows };
}

function listCoordinationOutcomes(db: Database, values: unknown[]) {
  return db.query<CoordinationOutcome>(
    `SELECT i.id,i.kind,i.source_name,i.source_key,i.created_at::text,i.delivered_at::text,i.reply_due_at IS NOT NULL AS reply_queued,
            i.reply_missing,i.reply_delivered_at::text,i.reply_failed_at::text,i.decision,i.decision_reason,i.matched_rule,
            i.accepted_scope,r.id AS launched_run_id,i.launch_error,r.status AS run_status,r.work_report_state,
            r.work_report_summary,r.work_report_question, CASE WHEN i.user_id=$2 THEN origin.chat_id END AS source_chat_id,
            CASE WHEN i.user_id=$2 THEN worker.chat_id END AS worker_chat_id,
            i.user_id=$2 AS owned,
            (i.user_id=$2 AND (i.accepted_scope IS NOT NULL OR i.attached_thread_id IS NOT NULL)
             AND (i.launch_error IS NOT NULL OR COALESCE(r.finished_at IS NOT NULL
               AND (r.status='failed' OR r.work_report_state IN ('blocked','failed')),false))
             AND NOT EXISTS (
               SELECT 1 FROM agent_threads t JOIN agent_runs active ON active.thread_id=t.id
               WHERE (t.source_input_id=i.id OR t.id=i.attached_thread_id) AND (t.closed_at IS NOT NULL OR active.status IN ('queued','running'))
             )) AS retryable
     FROM agent_coordination_inputs i
     LEFT JOIN agent_runs r ON r.id=COALESCE(i.launched_run_id,i.followup_run_id)
     LEFT JOIN agent_threads origin ON origin.id=i.source_thread_id AND origin.user_id=i.user_id
     LEFT JOIN agent_threads worker ON worker.id=r.thread_id AND worker.user_id=i.user_id
     WHERE i.agent_id=$1 AND ($3::boolean OR i.user_id=$2)
       AND i.kind IN ('request','candidate','work_followup')
     ORDER BY i.seq DESC LIMIT 100`,
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

export function queueMissingCoordinationReplies(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs i
     SET reply_text=$3, reply_due_at=now(), reply_missing=true
     FROM agent_threads t
     WHERE t.chat_id=$1 AND t.execution_role='coordinator' AND i.agent_id=t.agent_id
       AND i.id=ANY($2::uuid[]) AND i.kind='request' AND i.source_thread_id IS NOT NULL
       AND i.reply_due_at IS NULL`,
    values,
  );
}

export function acceptCoordinationWork(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs
     SET reply_text=$3, reply_due_at=now(), accepted_scope=$4, accepted_agent_id=$5,
         accepted_name=$6, accepted_parent_run_id=$7, launch_due_at=now()
     WHERE id=$1 AND agent_id=$2 AND kind='request' AND source_thread_id IS NOT NULL
       AND reply_due_at IS NULL`,
    values,
  );
}

export function attachCoordinationWork(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs i SET attached_thread_id=worker.id,
       accepted_agent_id=worker.agent_id,accepted_parent_run_id=work.accepted_parent_run_id,
       launch_due_at=now(),reply_text=$4,reply_due_at=now()
     FROM agent_threads worker JOIN agent_coordination_inputs work ON work.id=worker.source_input_id
     JOIN agent_runs parent ON parent.id=work.accepted_parent_run_id
     JOIN chats chat ON chat.id=worker.chat_id AND NOT chat.internal AND chat.deleted_at IS NULL
     WHERE i.id=$1 AND i.agent_id=$2 AND i.kind='request' AND i.source_thread_id IS NOT NULL
       AND i.reply_due_at IS NULL AND COALESCE(i.evaluation_request_id,i.id)=ANY($5::uuid[])
       AND work.agent_id=i.agent_id AND work.user_id=i.user_id AND work.accepted_scope IS NOT NULL
       AND worker.user_id=i.user_id AND worker.parent_thread_id=parent.thread_id
       AND worker.agent_id=work.accepted_agent_id AND worker.coordinator_managed
       AND worker.closed_at IS NULL AND worker.chat_id=$3
       AND strpos(i.content, '/thread/' || worker.chat_id::text) > 0`,
    values,
  );
}

export function claimCoordinationLaunches<T extends QueryResultRow>(db: Database) {
  return db.query<T>(
    `WITH due AS (
       SELECT id FROM agent_coordination_inputs
       WHERE launch_due_at <= now() AND launched_run_id IS NULL AND launch_error IS NULL
         AND NOT EXISTS (SELECT 1 FROM agent_coordination_state s
           WHERE s.agent_id=agent_coordination_inputs.agent_id AND s.paused_at IS NOT NULL)
       ORDER BY launch_due_at,seq LIMIT 16 FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_coordination_inputs i SET launch_due_at=now()+interval '30 seconds'
     FROM due WHERE i.id=due.id
     RETURNING i.id,i.agent_id,i.user_id,i.accepted_scope,i.accepted_agent_id,
               i.accepted_name,i.accepted_parent_run_id,i.launch_attempt,i.kind,i.attached_thread_id,i.attached_request_id,i.content`,
  );
}

export function settleCoordinationLaunch(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs SET launched_run_id=$2, launch_error=$3
     WHERE id=$1 AND launched_run_id IS NULL AND launch_error IS NULL AND launch_attempt=$4`,
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

export function retryCoordinationWork(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_coordination_inputs i
     SET launch_attempt=i.launch_attempt+1, launch_due_at=now(), launched_run_id=NULL, launch_error=NULL,
         attached_request_id=CASE WHEN i.attached_thread_id IS NOT NULL THEN gen_random_uuid() END
     WHERE i.id=$1 AND i.agent_id=$2 AND i.user_id=$3
       AND (i.accepted_scope IS NOT NULL OR i.attached_thread_id IS NOT NULL)
       AND (i.launch_error IS NOT NULL OR EXISTS (
         SELECT 1 FROM agent_runs r WHERE r.id=i.launched_run_id AND r.finished_at IS NOT NULL
           AND (r.status='failed' OR r.work_report_state IN ('blocked','failed'))
       ))
       AND NOT EXISTS (
         SELECT 1 FROM agent_threads t JOIN agent_runs r ON r.thread_id=t.id
         WHERE (t.source_input_id=i.id OR t.id=i.attached_thread_id) AND (t.closed_at IS NOT NULL OR r.status IN ('queued','running'))
       )
     RETURNING launch_attempt`,
    values,
  );
}

export function acceptedWorkForThread<T extends QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT i.id,i.agent_id,i.accepted_scope FROM agent_threads t JOIN agent_coordination_inputs i ON i.id=t.source_input_id
     JOIN agent_runs parent ON parent.id=i.accepted_parent_run_id
     WHERE t.id=$1 AND t.coordinator_managed AND t.parent_thread_id=parent.thread_id
       AND t.user_id=i.user_id AND t.agent_id=i.accepted_agent_id AND i.accepted_scope IS NOT NULL`,
    values,
  );
}

export function bindCoordinationFollowupRun(db: Database, threadId: string, runId: string, requestIds: string[]) {
  return db.query(
    `UPDATE agent_coordination_inputs SET followup_run_id=$2
     WHERE source_thread_id=$1 AND source_event_id=ANY($3::uuid[]) AND kind='work_followup' AND followup_run_id IS NULL`,
    [threadId, runId, requestIds],
  );
}

export function readWorkFollowups<T extends QueryResultRow>(db: Database, values: unknown[]) {
  return db.query<T>(
    `SELECT source_event_id FROM agent_coordination_inputs
     WHERE source_thread_id=$1 AND kind='work_followup' AND source_event_id=ANY($2::uuid[])
     UNION ALL
     SELECT COALESCE(i.attached_request_id,i.id) FROM agent_coordination_inputs i
     WHERE COALESCE(i.attached_request_id,i.id)=ANY($2::uuid[]) AND i.attached_thread_id=$1
       AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.id=COALESCE(i.attached_request_id,i.id) AND r.thread_id=$1)
       AND NOT EXISTS (SELECT 1 FROM agent_coordination_inputs handback WHERE handback.source_event_id=COALESCE(i.attached_request_id,i.id))
     ORDER BY source_event_id`,
    values,
  );
}

export function handBackWorkFollowup(db: Database, values: unknown[]) {
  return db.query(
    `WITH moved AS (
       UPDATE agent_coordination_inputs SET kind='request',wake=true,due_at=now(),delivered_at=NULL,
         reflected_at=NULL,lease_until=NULL,handback_reason=$3
       WHERE source_thread_id=$1 AND source_event_id=$2 AND kind='work_followup'
       RETURNING id
     ), attached AS (
       INSERT INTO agent_coordination_inputs(agent_id,user_id,source_thread_id,source_event_id,kind,content,wake,handback_reason)
       SELECT i.agent_id,i.user_id,i.source_thread_id,r.id,'request',i.content,true,$3
       FROM agent_coordination_inputs i JOIN agent_runs r ON r.id=COALESCE(i.attached_request_id,i.id) AND r.thread_id=$1
       WHERE COALESCE(i.attached_request_id,i.id)=$2 AND i.attached_thread_id=$1 AND i.source_thread_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM moved)
       ON CONFLICT (source_event_id) DO NOTHING
       RETURNING id
     )
     SELECT id FROM moved UNION ALL SELECT id FROM attached`,
    values,
  );
}

export function recordCoordinationWorkReport(db: Database, values: unknown[]) {
  return db.query(
    `UPDATE agent_runs r
     SET work_report_state=$3, work_report_summary=$4, work_report_question=$5, work_reported_at=now()
     FROM agent_threads t
     JOIN agent_coordination_inputs i ON i.id=t.source_input_id
     JOIN agent_runs parent ON parent.id=i.accepted_parent_run_id
     WHERE t.id=$1 AND r.id=$2 AND r.thread_id=t.id AND r.status='running'
       AND t.coordinator_managed AND t.user_id=i.user_id AND t.agent_id=i.accepted_agent_id
       AND t.parent_thread_id=parent.thread_id AND i.accepted_scope IS NOT NULL`,
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
    `SELECT i.id,i.user_id,i.source_thread_id,i.source_event_id,u.email,COALESCE(u.display_name,u.email) AS name,
       CASE WHEN r.work_report_state IS NOT NULL THEN jsonb_build_object(
         'state', r.work_report_state, 'summary', r.work_report_summary, 'question', r.work_report_question
       ) END AS report
       FROM agent_threads t JOIN agent_coordination_inputs i ON i.id=t.source_input_id
       LEFT JOIN agent_runs r ON r.thread_id=t.id AND r.id=$2
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

export function followCoordinationThread(db: Database, workerThreadId: string, sourceThreadId: string) {
  return db.query(
    `INSERT INTO agent_coordination_followed_threads(worker_thread_id, source_thread_id)
     SELECT worker.id, source.id FROM agent_threads worker
     JOIN agent_coordination_inputs work ON work.id=worker.source_input_id
     JOIN agent_threads source ON source.id=$2 AND source.user_id=worker.user_id AND source.agent_id=worker.agent_id
     JOIN chats chat ON chat.id=source.chat_id AND NOT chat.internal AND chat.deleted_at IS NULL
     WHERE worker.id=$1 AND worker.coordinator_managed AND worker.closed_at IS NULL
       AND work.accepted_scope IS NOT NULL AND worker.id<>source.id AND source.execution_role='thread'
     ON CONFLICT DO NOTHING`,
    [workerThreadId, sourceThreadId],
  );
}

export function unfollowCoordinationThread(db: Database, workerThreadId: string, sourceThreadId: string) {
  return db.query(
    `DELETE FROM agent_coordination_followed_threads WHERE worker_thread_id=$1 AND source_thread_id=$2`,
    [workerThreadId, sourceThreadId],
  );
}

export function listFollowedCoordinationThreads(db: Database, workerThreadId: string) {
  return db.query<{ thread_id: string; title: string | null }>(
    `SELECT source.id AS thread_id, source.title FROM agent_coordination_followed_threads follow
     JOIN agent_threads worker ON worker.id=follow.worker_thread_id
     JOIN agent_threads source ON source.id=follow.source_thread_id
       AND source.user_id=worker.user_id AND source.agent_id=worker.agent_id AND source.execution_role='thread'
     JOIN chats chat ON chat.id=source.chat_id AND NOT chat.internal AND chat.deleted_at IS NULL
     WHERE follow.worker_thread_id=$1 AND worker.closed_at IS NULL
     ORDER BY source.id`,
    [workerThreadId],
  );
}
