// The agent lane's column lists and row mappers: every agent store module
// selects with these and maps with these, so one agent, thread, run or
// notice has one wire shape.

import { pgTimestampToRfc3339, utcText } from "../../platform/time.js";
import type { AgentIntegrationEntry } from "../../platform/domain/integration-access.js";
import type {
  Agent,
  AgentNotice,
  AgentRun,
  AgentRunStatus,
  AgentStatus,
  AgentThread,
  AgentThreadType,
  AgentToolRef,
  AgentToolsMode,
  AgentTrigger,
  AgentVisibility,
} from "../types.js";

export const AGENT_COLUMNS = `a.id, a.org_id, a.owner_user_id, a.name, a.description, a.model,
  a.tools, a.tools_mode, a.generative_ui, a.visibility, a.resources, a.status, a.is_personal,
  (SELECT COALESCE(u.display_name, u.email) FROM users u WHERE u.id = a.owner_user_id) AS owner_label,
  (SELECT u.email FROM users u WHERE u.id = a.owner_user_id) AS owner_email,
  (SELECT u.avatar_url FROM users u WHERE u.id = a.owner_user_id) AS owner_avatar_url,
  (SELECT r.alias FROM model_routes r WHERE r.org_id = a.org_id AND r.model = a.model LIMIT 1) AS model_alias,
  COALESCE((SELECT array_agg(g.team_id::text ORDER BY g.team_id)
            FROM agent_access g WHERE g.agent_id = a.id AND g.team_id IS NOT NULL), '{}') AS team_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', i.name, 'ceiling', ai.ceiling) ORDER BY i.name)
            FROM agent_integrations ai JOIN integrations i ON i.id = ai.integration_id
            WHERE ai.agent_id = a.id), '[]'::jsonb) AS integrations,
  ${utcText("a.deleted_at")} AS deleted_at, ${utcText("a.purge_after")} AS purge_after,
  ${utcText("a.created_at")} AS created_at, ${utcText("a.updated_at")} AS updated_at`;

export const THREAD_COLUMNS = `t.id, t.agent_id, t.user_id, t.chat_id, t.title, t.title_locked, t.type,
  t.parent_thread_id, t.origin_thread_id, t.depth, ${utcText("t.closed_at")} AS closed_at,
  ${utcText("t.created_at")} AS created_at, ${utcText("t.last_activity_at")} AS last_activity_at`;

export const RUN_COLUMNS = `r.internal, r.id, r.agent_id, r.user_id, r.thread_id, r.routine_id, r.parent_run_id,
  r.delegate_agent_id, r.depth, r.trigger, r.status, r.summary,
  r.error_code, r.error_message, r.error_step, r.tokens,
  ${utcText("r.started_at")} AS started_at, ${utcText("r.finished_at")} AS finished_at,
  ${utcText("r.created_at")} AS created_at,
  (SELECT name FROM agents WHERE id = r.agent_id) AS agent_name,
  (SELECT name FROM agent_routines WHERE id = r.routine_id) AS routine_name`;

export const NOTICE_COLUMNS = `n.id, n.org_id, n.agent_id, n.user_id, n.kind, n.payload,
  ${utcText("n.read_at")} AS read_at, ${utcText("n.created_at")} AS created_at`;

function optionalTime(value: unknown): string | null {
  return value === null || value === undefined ? null : pgTimestampToRfc3339(value as string);
}

export function toAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    owner_user_id: row.owner_user_id as string,
    owner_label: (row.owner_label as string | null) ?? null,
    owner_email: (row.owner_email as string | null) ?? null,
    owner_avatar_url: (row.owner_avatar_url as string | null) ?? null,
    name: row.name as string,
    description: (row.description as string | null) ?? "",
    model: row.model as string,
    model_alias: (row.model_alias as string | null) ?? null,
    tools: (row.tools as AgentToolRef[] | null) ?? [],
    tools_mode: (row.tools_mode as AgentToolsMode | null) ?? "selected",
    generative_ui: row.generative_ui === undefined || row.generative_ui === null ? true : Boolean(row.generative_ui),
    visibility: row.visibility as AgentVisibility,
    resources: (row.resources as Record<string, unknown> | null) ?? {},
    status: row.status as AgentStatus,
    is_personal: Boolean(row.is_personal),
    can_manage: row.can_manage === true,
    team_ids: (row.team_ids as string[] | null) ?? [],
    integrations: (row.integrations as AgentIntegrationEntry[] | null) ?? [],
    deleted_at: optionalTime(row.deleted_at),
    purge_after: optionalTime(row.purge_after),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    updated_at: pgTimestampToRfc3339(row.updated_at as string),
  };
}

export function toThread(row: Record<string, unknown>): AgentThread {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    user_id: row.user_id as string,
    chat_id: row.chat_id as string,
    title: (row.title as string | null) ?? "",
    title_locked: Boolean(row.title_locked),
    type: row.type as AgentThreadType,
    parent_thread_id: (row.parent_thread_id as string | null) ?? null,
    origin_thread_id: (row.origin_thread_id as string | null) ?? null,
    depth: Number(row.depth ?? 0),
    closed_at: optionalTime(row.closed_at),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    last_activity_at: pgTimestampToRfc3339(row.last_activity_at as string),
  };
}

export function toRun(row: Record<string, unknown>): AgentRun {
  return {
    ...(row.internal === true ? { internal: true as const } : {}),
    id: row.id as string,
    agent_id: row.agent_id as string,
    user_id: (row.user_id as string | null) ?? null,
    thread_id: (row.thread_id as string | null) ?? null,
    routine_id: (row.routine_id as string | null) ?? null,
    parent_run_id: (row.parent_run_id as string | null) ?? null,
    delegate_agent_id: (row.delegate_agent_id as string | null) ?? null,
    depth: Number(row.depth),
    trigger: row.trigger as AgentTrigger,
    status: row.status as AgentRunStatus,
    summary: (row.summary as string | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    error_step: (row.error_step as string | null) ?? null,
    tokens: Number(row.tokens ?? 0),
    started_at: optionalTime(row.started_at),
    finished_at: optionalTime(row.finished_at),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    agent_name: (row.agent_name as string | null) ?? null,
    routine_name: (row.routine_name as string | null) ?? null,
  };
}

export function toNotice(row: Record<string, unknown>): AgentNotice {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    agent_id: (row.agent_id as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    kind: row.kind as string,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    read_at: optionalTime(row.read_at),
    created_at: pgTimestampToRfc3339(row.created_at as string),
  };
}
