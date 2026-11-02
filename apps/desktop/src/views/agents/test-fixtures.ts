// Whole wire rows for tests: each factory fills every field the contract
// requires, and a test overrides only what it is about.

import type { Agent, AgentRoutine, AgentRun, AgentThread } from "@guild/wire/rest";

const AT = "2026-11-01T00:00:00Z";

export function makeAgent(patch: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    org_id: "o1",
    owner_user_id: "u1",
    owner_label: null,
    owner_email: null,
    owner_avatar_url: null,
    name: "Agent",
    description: "",
    model: "m1",
    model_alias: null,
    tools: [],
    tools_mode: "selected",
    visibility: "private",
    resources: {},
    status: "active",
    is_personal: false,
    team_ids: [],
    deleted_at: null,
    purge_after: null,
    created_at: AT,
    updated_at: AT,
    ...patch,
  };
}

export function makeRun(patch: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "r1",
    agent_id: "a1",
    user_id: null,
    thread_id: null,
    routine_id: null,
    parent_run_id: null,
    delegate_agent_id: null,
    depth: 0,
    trigger: "manual",
    status: "running",
    summary: null,
    error_code: null,
    error_message: null,
    error_step: null,
    tokens: 0,
    started_at: null,
    finished_at: null,
    created_at: AT,
    agent_name: null,
    routine_name: null,
    ...patch,
  };
}

export function makeThread(patch: Partial<AgentThread> = {}): AgentThread {
  return {
    id: "t1",
    agent_id: "a1",
    user_id: "u1",
    chat_id: "chat-t1",
    title: "Thread",
    title_locked: false,
    type: "user",
    is_default: false,
    parent_thread_id: null,
    origin_thread_id: null,
    depth: 0,
    closed_at: null,
    created_at: AT,
    last_activity_at: AT,
    archived: false,
    deleted: false,
    ...patch,
  };
}

export function makeRoutine(patch: Partial<AgentRoutine> = {}): AgentRoutine {
  return {
    id: "r1",
    agent_id: "a1",
    created_by_user_id: null,
    name: "Routine",
    kind: "cron",
    schedule: "0 9 * * *",
    timezone: "UTC",
    run_at: null,
    prompt: "",
    context: "isolated",
    enabled: true,
    next_run_at: null,
    created_at: AT,
    updated_at: AT,
    last_run: null,
    ...patch,
  };
}
