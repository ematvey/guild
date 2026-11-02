// Routine definitions and occurrences: interval normalization, five-field
// cron validation, DST-aware next occurrences, CRUD next_run_at maintenance,
// idempotent occurrence identity and the pending-reminder cap.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import {
  MAX_PENDING_REMINDERS,
  createOccurrence,
  createRoutine,
  deleteRoutine,
  getRoutine,
  nextOccurrence,
  normalizeRoutineSchedule,
  scheduleReminder,
  updateRoutine,
} from "../../agents/routines.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

describe("routine schedule parsing", () => {
  it("normalizes interval sugar to five-field cron", () => {
    expect(normalizeRoutineSchedule("15m", "UTC")).toBe("*/15 * * * *");
    expect(normalizeRoutineSchedule("every 15m", "UTC")).toBe("*/15 * * * *");
    expect(normalizeRoutineSchedule("1h", "UTC")).toBe("0 * * * *");
    expect(normalizeRoutineSchedule("2h", "UTC")).toBe("0 */2 * * *");
    expect(normalizeRoutineSchedule("1d", "UTC")).toBe("0 0 * * *");
  });

  it("rejects bad schedules, timezones and sub-minute intervals", () => {
    expect(() => normalizeRoutineSchedule("every 30s", "UTC")).toThrow(/five fields/);
    expect(() => normalizeRoutineSchedule("* * * * * *", "UTC")).toThrow(/five fields/);
    expect(() => normalizeRoutineSchedule("0 0 * * *", "Not/AZone")).toThrow(/timezone/);
    expect(() => nextOccurrence("0 0 * * *", "Not/AZone")).toThrow(/timezone/);
  });

  it("keeps a local wall-clock time across the spring DST change", () => {
    const first = nextOccurrence("0 9 * * *", "America/New_York", new Date("2026-03-07T00:00:00Z"));
    const second = nextOccurrence("0 9 * * *", "America/New_York", new Date("2026-03-08T00:00:00Z"));
    expect(first.toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(second.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(second.getTime() - first.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("resolves the autumn DST repeat and the spring gap", () => {
    const repeat = nextOccurrence("30 1 * * *", "America/New_York", new Date("2026-11-01T00:00:00Z"));
    expect(repeat.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const after = nextOccurrence("30 1 * * *", "America/New_York", new Date("2026-11-01T06:30:00Z"));
    expect(after.toISOString()).toBe("2026-11-02T06:30:00.000Z");
    const gap = nextOccurrence("30 2 * * *", "America/New_York", new Date("2026-03-08T00:00:00Z"));
    expect(gap.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("routine store", () => {
  let store: AgentStore;
  let owner: UserRow;
  let orgId: string;
  let agentId: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-routines-org')", [orgId]);
    const id = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-routines@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [id, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    agentId = (await store.create(owner, { name: "Scheduler", model: "GLM-Test" })).id;
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("creates, updates, disables and deletes a routine with next_run_at", async () => {
    const routine = await createRoutine(env!.db, agentId, {
    created_by_user_id: owner.id,
      name: "Quarter hour",
      kind: "cron",
      schedule: "every 15m",
      timezone: "Europe/Berlin",
      prompt: "Check the inbox.",
    });
    expect(routine.schedule).toBe("*/15 * * * *");
    expect(routine.next_run_at).not.toBeNull();
    expect(routine.enabled).toBe(true);

    const renamed = await updateRoutine(env!.db, agentId, routine.id, { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.next_run_at).toBe(routine.next_run_at);

    const hourly = await updateRoutine(env!.db, agentId, routine.id, { schedule: "1h" });
    expect(hourly.schedule).toBe("0 * * * *");
    expect(hourly.next_run_at).not.toBeNull();

    const disabled = await updateRoutine(env!.db, agentId, routine.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.next_run_at).toBeNull();
    const enabled = await updateRoutine(env!.db, agentId, routine.id, { enabled: true });
    expect(enabled.next_run_at).not.toBeNull();

    expect((await store.runs.listRoutines(agentId)).map((item) => item.id)).toContain(routine.id);
    const run = await store.runs.createRun({
      agent_id: agentId,
      user_id: owner.id,
      routine_id: routine.id,
      trigger: "routine",
      status: "succeeded",
      summary: "Ran the check",
    });
    const listed = (await store.runs.listRoutines(agentId)).find((item) => item.id === routine.id);
    expect(listed?.last_run?.id).toBe(run.id);
    expect((await getRoutine(env!.db, agentId, routine.id)).id).toBe(routine.id);
    await deleteRoutine(env!.db, agentId, routine.id);
    await expect(getRoutine(env!.db, agentId, routine.id)).rejects.toMatchObject({ status: 404 });
  });

  it("creates a once routine whose next run is its run_at", async () => {
    const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const routine = await createRoutine(env!.db, agentId, {
    created_by_user_id: owner.id,
      name: "One shot",
      kind: "once",
      run_at: runAt,
      prompt: "Send the digest.",
    });
    expect(routine.kind).toBe("once");
    expect(routine.schedule).toBeNull();
    expect(routine.run_at).toBe(runAt);
    expect(routine.next_run_at).toBe(runAt);
  });

  it("creates occurrences idempotently on (routine_id, scheduled_for)", async () => {
    const routine = await createRoutine(env!.db, agentId, {
    created_by_user_id: owner.id,
      name: "Occurrence",
      kind: "cron",
      schedule: "0 * * * *",
      prompt: "Tick.",
    });
    const when = new Date("2026-01-01T00:00:00.000Z");
    const first = await createOccurrence(env!.db, routine.id, when);
    const second = await createOccurrence(env!.db, routine.id, when);
    expect(second.id).toBe(first.id);
    const count = await env!.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM agent_routine_occurrences WHERE routine_id = $1",
      [routine.id],
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  it("caps pending reminders per agent", async () => {
    const reminderAgent = await store.create(owner, { name: "Reminders", model: "GLM-Test" });
    const base = Date.now() + 60_000;
    for (let index = 0; index < MAX_PENDING_REMINDERS; index++) {
      await scheduleReminder(env!.db, reminderAgent.id, {
        created_by_user_id: owner.id,
        at: new Date(base + index * 60_000).toISOString(),
        prompt: `Reminder ${index}`,
      });
    }
    await expect(
      scheduleReminder(env!.db, reminderAgent.id, {
        created_by_user_id: owner.id,
        at: new Date(base + 60 * 60_000).toISOString(),
        prompt: "One too many",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
