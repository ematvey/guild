import {
  findCoordinationThread,
  readCoordinationRole,
  retryCoordinationInput,
  claimCoordinationInputs,
  deliverCoordinationInput,
  initializeCoordinationState,
  listCoordinators,
  readCoordinationState,
  readReflectionStatus,
  markInputsReflected,
  clearReflection,
  pendingReflectionInputs,
  startReflection,
  resetReflection,
  uncompactedInputs,
  markCompacted,
} from "./store/coordination.js";
// One Agent's persistent coordination: durable attributed inputs, passive
// observations, timed wakes and background memory/context maintenance.
import type { EntryDraft } from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import { withTransaction } from "../platform/db.js";
import type { AgentStore } from "./store.js";
import type { Agent, AgentThread } from "./types.js";
import type { GuildRuntime } from "../harness/runtime.js";
import type { Logger } from "pino";
import { startThreadRun } from "./thread-run.js";

export interface CoordinationSettings {
  enabled: boolean;
  scope: "agent" | "member";
  coordinator_model: string;
  worker_model: string;
  reflection_model: string;
  compaction_model: string;
  reflection_events: number;
  reflection_seconds: number;
  compaction_events: number;
  compaction_seconds: number;
}

export function coordinationSettings(agent: Pick<Agent, "resources" | "is_personal" | "model">): CoordinationSettings {
  const raw = agent.resources["assistant"];
  const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const model = (key: string): string =>
    typeof value[key] === "string" && value[key] !== "" ? (value[key] as string) : agent.model;
  const positive = (key: string, fallback: number): number =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? Math.max(1, Math.min(86400, Math.floor(value[key] as number)))
      : fallback;
  return {
    enabled: typeof value["enabled"] === "boolean" ? value["enabled"] : agent.is_personal,
    scope: agent.is_personal || value["scope"] === "member" ? "member" : "agent",
    coordinator_model: model("coordinator_model"),
    worker_model: model("worker_model"),
    reflection_model: model("reflection_model"),
    compaction_model: model("compaction_model"),
    reflection_events: positive("reflection_events", 20),
    reflection_seconds: positive("reflection_seconds", 1800),
    compaction_events: positive("compaction_events", 60),
    compaction_seconds: positive("compaction_seconds", 3600),
  };
}

export interface CoordinationInput {
  id: string;
  seq: string;
  agent_id: string;
  user_id: string;
  source_thread_id: string | null;
  source_event_id: string | null;
  kind: string;
  content: string;
  wake: boolean;
  name: string;
  email: string;
}

export function coordinationPreamble(input: CoordinationInput): string {
  return `<coordination_input>\n${JSON.stringify({
    input_id: input.id,
    kind: input.kind,
    user: { id: input.user_id, name: input.name, email: input.email },
    thread_id: input.source_thread_id,
    message_id: input.source_event_id,
  })}\n</coordination_input>\n${input.content}`;
}

/** Serializes first creation across processes. Coordinator history is an
 *  internal chat; member-facing inboxes are separate ordinary Threads. */
export async function ensureCoordinationThread(
  pool: PlatformPool,
  store: AgentStore,
  agent: Agent,
  userId: string,
  role: "coordinator" | "inbox",
): Promise<AgentThread> {
  const lock = await pool.connect();
  const key = `coordinator:${agent.id}:${role}:${role === "inbox" ? userId : ""}`;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    const current = await findCoordinationThread<{ id: string }>(lock, [agent.id, role, userId]);
    if (current.rows[0] !== undefined) return (await store.threads.threadById(current.rows[0].id))!;
    return await store.threads.createThread(
      agent.id,
      role === "coordinator" ? agent.owner_user_id : userId,
      role === "coordinator" ? "Coordinator" : agent.name,
      role === "coordinator" ? "routine" : "user",
      { executionRole: role, internal: role === "coordinator" },
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    lock.release();
  }
}

export async function coordinationRole(
  pool: PlatformPool,
  chatId: string,
): Promise<{
  execution_role: string;
  coordinator_managed: boolean;
  source_input_id: string | null;
} | null> {
  return (
    (
      await readCoordinationRole<{
        execution_role: string;
        coordinator_managed: boolean;
        source_input_id: string | null;
      }>(pool, [chatId])
    ).rows[0] ?? null
  );
}

export class AgentCoordination {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private maintainAfter = 0;
  constructor(
    private readonly deps: {
      pool: PlatformPool;
      store: AgentStore;
      runtime: Pick<GuildRuntime, "submitTurn" | "writeEntry" | "compactChat" | "stopChat">;
      log: Logger;
    },
  ) {}
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
    this.timer.unref();
    void this.tick();
  }
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const inputs = await this.claim();
      for (const input of inputs) {
        try {
          await this.deliver(input);
        } catch (error) {
          this.deps.log.warn({ err: error, inputId: input.id }, "coordination delivery deferred");
          await retryCoordinationInput(this.deps.pool, [input.id]);
        }
      }
      if (Date.now() >= this.maintainAfter) {
        this.maintainAfter = Date.now() + 5000;
        await this.maintain();
      }
    } catch (error) {
      this.deps.log.warn({ err: error }, "coordination pass failed");
    } finally {
      this.ticking = false;
    }
  }

  private async claim(): Promise<CoordinationInput[]> {
    return withTransaction(this.deps.pool, async (client) => {
      const rows = await claimCoordinationInputs<CoordinationInput>(client, []);
      return rows.rows;
    });
  }

  private async deliver(input: CoordinationInput): Promise<void> {
    const { pool, store, runtime } = this.deps;
    const agent = await store.fetchAgent(input.agent_id);
    const coordinator = await ensureCoordinationThread(pool, store, agent, agent.owner_user_id, "coordinator");
    const content = coordinationPreamble(input);
    if (input.wake) {
      await runtime.submitTurn(coordinator.chat_id, agent.org_id, {
        orgId: agent.org_id,
        requestId: input.id,
        content,
        images: [],
        model: coordinationSettings(agent).coordinator_model,
        entry: { kind: "guild.coordination-input", data: { input_id: input.id } },
      });
    } else {
      const entry: EntryDraft = {
        kind: "guild.coordination-observation",
        data: { input_id: input.id },
        model: [{ role: "user", content, timestamp: Date.now() }],
      };
      await runtime.writeEntry(coordinator.chat_id, { ...entry, data: { input_id: input.id, request_id: input.id } });
    }
    await deliverCoordinationInput(pool, [input.id]);
  }

  private async maintain(): Promise<void> {
    const { pool, store, runtime } = this.deps;
    await initializeCoordinationState(pool, []);
    const agents = await listCoordinators<{ agent_id: string; chat_id: string }>(pool, []);
    for (const row of agents.rows) {
      const lock = await pool.connect();
      const key = `coordination-maintenance:${row.agent_id}`;
      const held = (await lock.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [key]))
        .rows[0]?.held;
      if (!held) {
        lock.release();
        continue;
      }
      try {
        const agent = await store.fetchAgent(row.agent_id);
        const settings = coordinationSettings(agent);
        if (!settings.enabled || agent.status !== "active") continue;
        const state = (
          await readCoordinationState<{
            reflection_thread_id: string | null;
            reflection_inputs: string[];
            reflection_age: number;
            compaction_age: number;
          }>(lock, [agent.id])
        ).rows[0]!;
        let active = false;
        if (state.reflection_thread_id !== null) {
          const run = (await readReflectionStatus<{ status: string }>(lock, [state.reflection_thread_id])).rows[0];
          active = run?.status === "queued" || run?.status === "running";
          if (active && state.reflection_age > 120) {
            const thread = await store.threads.threadById(state.reflection_thread_id);
            if (thread !== null) await runtime.stopChat(thread.chat_id);
          }
          if (!active && run !== undefined) {
            if (run.status === "succeeded" || run.status === "silent") {
              await markInputsReflected(lock, [state.reflection_inputs]);
            }
            await clearReflection(lock, [agent.id]);
          }
        }
        const recent = await pendingReflectionInputs<{ id: string; seq: string; content: string; kind: string }>(lock, [
          agent.id,
        ]);
        if (
          !active &&
          recent.rows.length > 0 &&
          (recent.rows.length >= settings.reflection_events || state.reflection_age >= settings.reflection_seconds)
        ) {
          const thread = await store.threads.createThread(
            agent.id,
            agent.owner_user_id,
            "Memory reflection",
            "routine",
            { executionRole: "reflection", internal: true },
          );
          await startReflection(lock, [agent.id, thread.id, recent.rows.map((x) => x.id)]);
          try {
            await startThreadRun(
              { store, runtime },
              {
                agentId: agent.id,
                thread,
                failureCode: "reflection_failed",
                content:
                  "Review the activity below. Update MEMORY.md and supporting notes with durable lessons, decisions and user corrections. Use read/edit/write for memory changes; inspect files before editing and reconcile conflicts. Keep summaries concise with source IDs. Do not change permissions, message users or perform external work. Finish within six file operations.\n" +
                  JSON.stringify(recent.rows),
                run: { user_id: agent.owner_user_id, trigger: "manual", summary: "Memory reflection" },
              },
            );
          } catch (error) {
            await resetReflection(lock, [agent.id]);
            this.deps.log.warn({ err: error, agentId: agent.id }, "reflection deferred");
          }
        }
        const fresh = Number((await uncompactedInputs<{ n: string }>(lock, [agent.id])).rows[0]?.n ?? 0);
        if (
          fresh >= settings.compaction_events ||
          (fresh >= 10 && state.compaction_age >= settings.compaction_seconds)
        ) {
          await runtime.compactChat(row.chat_id);
          await markCompacted(lock, [agent.id]);
        }
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
        lock.release();
      }
    }
  }
}
