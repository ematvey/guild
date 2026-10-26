// Routine scheduler: materializing due schedules, transactional claiming,
// coalescing missed occurrences, retries and auto-disable, and manual runs.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import { ThreadStore } from "../../platform/store/thread.js";
import {
  AgentScheduler,
  MAX_CONSECUTIVE_FAILURES,
  runRoutineNow,
  type AgentSchedulerDeps,
} from "../../agents/scheduler.js";
import { createOccurrence } from "../../agents/routines.js";
import type { Agent, AgentRoutine } from "../../agents/types.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent scheduler", () => {
  let store: AgentStore;
  let owner: UserRow;
  let orgId: string;
  let agent: Agent;
  let scheduler: AgentScheduler;
  let runtime: AgentSchedulerDeps["runtime"];
  let calls: { chatId: string; orgId: string; content: string; model: string | null }[];

  function makeScheduler(): AgentScheduler {
    calls = [];
    runtime = {
      submitTurn: async (chatId, org, input) => {
        calls.push({ chatId, orgId: org, content: input.content, model: input.model });
        return calls.length;
      },
    };
    return new AgentScheduler({
      pool: env!.db,
      store,
      threads: new ThreadStore(env!.db),
      runtime,
      log: pino({ level: "silent" }),
      enabled: false,
    });
  }

  async function makeRoutine(name: string): Promise<AgentRoutine> {
    return store.createRoutine(agent.id, {
    created_by_user_id: owner.id,
      name,
      kind: "cron",
      schedule: "0 0 1 1 *",
      timezone: "UTC",
      prompt: "Do the routine work.",
    });
  }

  async function occurrenceStatuses(routineId: string): Promise<{ status: string; attempts: number; scheduled_for: string }[]> {
    const res = await env!.db.query<{ status: string; attempts: number; scheduled_for: Date }>(
      `SELECT status, attempts, scheduled_for FROM agent_routine_occurrences
       WHERE routine_id = $1 ORDER BY scheduled_for ASC`,
      [routineId],
    );
    return res.rows.map((row) => ({
      status: row.status,
      attempts: Number(row.attempts),
      scheduled_for: row.scheduled_for.toISOString(),
    }));
  }

  async function failRun(runId: string, when = new Date(Date.now() - 10 * 60_000)): Promise<void> {
    await store.updateRun(runId, {
      status: "failed",
      error_code: "run_error",
      error_message: "boom",
      finished_at: when.toISOString(),
    });
  }

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-scheduler-org')", [orgId]);
    const id = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-scheduler@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [id, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    agent = await store.create(owner, { name: "Scheduler", model: "GLM-Test" });
    scheduler = makeScheduler();
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("materializes missed occurrences and coalesces to the latest one", async () => {
    scheduler = makeScheduler();
    const routine = await store.createRoutine(agent.id, {
    created_by_user_id: owner.id,
      name: "Coalesce",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      prompt: "Coalesced run.",
    });
    await env!.db.query(
      "UPDATE agent_routines SET next_run_at = now() - interval '3 minutes' WHERE id = $1",
      [routine.id],
    );
    const now = new Date();
    await scheduler.materializeDue(now);
    const materialized = await occurrenceStatuses(routine.id);
    expect(materialized.length).toBeGreaterThanOrEqual(3);
    const advanced = await store.getRoutine(agent.id, routine.id);
    expect(Date.parse(advanced.next_run_at!)).toBeGreaterThan(now.getTime());

    const claimed = await scheduler.claimDue(now);
    expect(claimed).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content).toBe("Coalesced run.");
    const statuses = await occurrenceStatuses(routine.id);
    expect(statuses.filter((row) => row.status === "skipped").length).toBe(statuses.length - 1);
    expect(statuses.at(-1)!.status).toBe("claimed");
    expect(statuses.at(-1)!.attempts).toBe(1);

    const runs = await store.listRoutineRuns(agent.id, routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("routine");
    const threads = await env!.db.query<{ kind: string }>("SELECT kind FROM agent_threads WHERE id = $1", [
      runs[0]!.thread_id,
    ]);
    expect(threads.rows[0]!.kind).toBe("routine_run");
    expect((await store.listThreads(agent.id, owner.id)).some((thread) => thread.id === runs[0]!.thread_id)).toBe(false);
    const first = await env!.db.query<{ type: string; content: string }>(
      "SELECT type, payload->>'content' AS content FROM thread_events WHERE chat_id = (SELECT chat_id FROM agent_threads WHERE id = $1) ORDER BY seq LIMIT 1",
      [runs[0]!.thread_id],
    );
    expect(first.rows[0]).toEqual({ type: "user_message", content: "Coalesced run." });
  });

  it("retries an occurrence three times and then fails it with a notice", async () => {
    scheduler = makeScheduler();
    const routine = await makeRoutine("Retries");
    const scheduled = new Date();
    await createOccurrence(env!.db, routine.id, scheduled);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = await scheduler.claimDue(new Date(Date.now() + attempt * 10 * 60_000));
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attempts).toBe(attempt);
      const latest = (await store.listOccurrences(routine.id))[0]!;
      expect(latest.status).toBe("claimed");
      expect(latest.run_id).not.toBeNull();
      await failRun(latest.run_id!);
      await scheduler.reconcileClaimed();
      const after = (await store.listOccurrences(routine.id))[0]!;
      if (attempt < 3) {
        expect(after.status).toBe("pending");
        expect(after.attempts).toBe(attempt);
      } else {
        expect(after.status).toBe("failed");
        expect(after.last_error).toBe("boom");
      }
    }
    const notices = await store.listNotices(owner.id, orgId);
    expect(notices.some((notice) => notice.kind === "routine_failed" && notice.agent_id === agent.id)).toBe(true);
  });

  it("auto-disables after ten consecutive failed occurrences", async () => {
    scheduler = makeScheduler();
    const routine = await makeRoutine("Auto disable");
    const base = Date.now() - MAX_CONSECUTIVE_FAILURES * 60_000;
    for (let index = 0; index < MAX_CONSECUTIVE_FAILURES - 1; index++) {
      const occurrence = await createOccurrence(env!.db, routine.id, new Date(base + index * 60_000));
      await env!.db.query("UPDATE agent_routine_occurrences SET status = 'failed', attempts = 3 WHERE id = $1", [
        occurrence.id,
      ]);
    }
    await createOccurrence(env!.db, routine.id, new Date());

    for (let attempt = 1; attempt <= 3; attempt++) {
      await scheduler.claimDue(new Date(Date.now() + attempt * 10 * 60_000));
      const latest = (await store.listOccurrences(routine.id))[0]!;
      await failRun(latest.run_id!);
      await scheduler.reconcileClaimed();
    }
    const disabled = await store.getRoutine(agent.id, routine.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.next_run_at).toBeNull();
    const notices = await store.listNotices(owner.id, orgId);
    expect(notices.some((notice) => notice.kind === "routine_disabled")).toBe(true);
  });

  it("runs a routine manually and refuses an archived agent", async () => {
    scheduler = makeScheduler();
    const routine = await store.createRoutine(agent.id, {
    created_by_user_id: owner.id,
      name: "Manual",
      kind: "once",
      run_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      prompt: "Manual run.",
    });
    const run = await runRoutineNow({ pool: env!.db, store, threads: new ThreadStore(env!.db), runtime }, agent, routine);
    expect(run.trigger).toBe("manual");
    expect(calls).toHaveLength(1);
    const occurrence = (await store.listOccurrences(routine.id))[0]!;
    expect(occurrence.status).toBe("claimed");
    expect(occurrence.run_id).toBe(run.id);

    const archived = await store.create(owner, { name: "Archived", model: "GLM-Test" });
    const archivedRoutine = await store.createRoutine(archived.id, {
    created_by_user_id: owner.id,
      name: "Archived routine",
      kind: "once",
      run_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      prompt: "Never runs.",
    });
    await store.archive(owner, archived.id);
    await expect(
      runRoutineNow({ pool: env!.db, store, threads: new ThreadStore(env!.db), runtime }, { ...archived, status: "archived" }, archivedRoutine),
    ).rejects.toThrow(/not active/);
  });
});
