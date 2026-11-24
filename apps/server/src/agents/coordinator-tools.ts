import {
  readCoordinationSource,
  isInternalChat,
  insertCoordinatorWake,
  listCoordinatorWakes,
  cancelCoordinatorWake,
  listCoordinationThreads,
} from "./store/coordination.js";
import { createRoutine, listRoutines, getRoutine, updateRoutine, deleteRoutine } from "./routines.js";
// Coordination capabilities operate on attributed inputs and owned Threads;
// they do not expose Integrations, Apps or Machine execution.
import { LiveDoc, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { inputRequestIds } from "../storage/postgres/queries.js";
import type { PlatformPool } from "../platform/db.js";
import type { AgentStore } from "./store.js";
import type { Agent } from "./types.js";
import type { IdentityStore } from "../platform/store/identity.js";
import { uuidv5 } from "../platform/time.js";
import { spawn, send, createSubagentTools, type SubagentsToolContext } from "./subagents.js";
import { coordinationSettings } from "./coordination.js";
import { agentMessageEntry } from "../chats/agent-message.js";
import { readThreadTranscript } from "./thread-read.js";

export function coordinatorTools(deps: {
  pool: PlatformPool;
  store: AgentStore;
  agent: Agent;
  identity: Pick<IdentityStore, "getUser">;
  subagents: SubagentsToolContext;
}): ToolRegistration[] {
  const { pool, agent, store } = deps;
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (
      args: Record<string, unknown>,
      callId: string,
      api: ToolExecutionApi,
      context: Parameters<ToolRegistration["execute"]>[2],
    ) => Promise<unknown>,
  ): ToolRegistration => ({
    name,
    description,
    replay: "safe",
    parameters: { type: "object", properties, required },
    execute: async (args, api, context) => {
      try {
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(
                await run(args as Record<string, unknown>, `${api.taskId}:${api.callId}`, api, context),
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  });
  const str = { type: "string" };
  const source = async (
    id: unknown,
  ): Promise<{ id: string; user_id: string; source_thread_id: string | null; kind: string }> => {
    const row = (
      await readCoordinationSource<{ id: string; user_id: string; source_thread_id: string | null; kind: string }>(
        pool,
        [id, agent.id],
      )
    ).rows[0];
    if (row === undefined) throw new Error("input_id must reference an input of this Agent");
    return row;
  };
  const routineManager = async (
    inputId: unknown,
    api: ToolExecutionApi,
    context: Parameters<ToolRegistration["execute"]>[2],
  ) => {
    const active = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
    const inputs = active?.inputs.map(Number) ?? [];
    const requests = await inputRequestIds(pool, inputs);
    if (typeof inputId !== "string" || !requests.includes(inputId) || inputs.length !== requests.length) {
      throw new Error("Routine changes require an input from the active Turn");
    }
    const origin = await source(inputId);
    const origins = await Promise.all(requests.filter((id) => id !== inputId).map(source));
    if (
      origin.kind !== "request" ||
      origins.some((other) => other.user_id !== origin.user_id || other.kind !== "request")
    ) {
      throw new Error("Routine changes require direct requests from one Member");
    }
    const member = await deps.identity.getUser(origin.user_id);
    await store.requireAccess(member, agent.id, "manage");
    return member;
  };
  return [
    ...createSubagentTools(deps.subagents).filter((t) =>
      ["list_agents", "list", "read_thread", "cancel", "close"].includes(t.name),
    ),
    tool(
      "spawn",
      "Start a worker asynchronously. Use the triggering input_id for attribution. agent defaults to this Agent.",
      { input_id: str, task: str, agent: str, name: str },
      ["input_id", "task"],
      async (args, callId) => {
        const origin = await source(args["input_id"]);
        const requester = await deps.identity.getUser(origin.user_id);
        const parentRun = await deps.subagents.parentRun();
        const result = await spawn(
          {
            ...deps.subagents,
            requester,
            parentRun: async () => ({ ...parentRun, user_id: origin.user_id }),
            coordination: { managed: true, sourceInputId: origin.id, actionKey: `spawn:${callId}` },
          },
          {
            agent: typeof args["agent"] === "string" ? args["agent"] : agent.id,
            task: String(args["task"]),
            ...(typeof args["name"] === "string" ? { name: args["name"] } : {}),
          },
        );
        return { ...result, url: `/thread/${result.chat_id}` };
      },
    ),
    tool(
      "send",
      "Send follow-up instructions to an existing worker thread.",
      { thread_id: str, text: str },
      ["thread_id", "text"],
      async (args, callId) => {
        const child = await store.threads.threadById(String(args["thread_id"]));
        if (child === null) throw new Error("No such worker");
        const requester = await deps.identity.getUser(child.user_id);
        const parentRun = await deps.subagents.parentRun();
        return send(
          {
            ...deps.subagents,
            requester,
            coordination: { managed: true, actionKey: `send:${callId}` },
            parentRun: async () => ({ ...parentRun, user_id: child.user_id }),
          },
          { thread_id: child.id, text: String(args["text"]) },
        );
      },
    ),
    tool(
      "send_message",
      "Explicitly send a short reply to the user and thread identified by input_id. Optional thread_id must belong to that user and this Agent. Surface a task with surface_thread_id.",
      { input_id: str, text: str, thread_id: str, surface_thread_id: str },
      ["input_id", "text"],
      async (args, callId) => {
        const origin = await source(args["input_id"]);
        const member = await deps.identity.getUser(origin.user_id);
        await store.requireAccess(member, agent.id, "use");
        const target = typeof args["thread_id"] === "string" ? args["thread_id"] : origin.source_thread_id;
        if (target === null) throw new Error("Choose a recipient thread_id for this event");
        const thread = await store.threads.getThread(agent.id, origin.user_id, target);
        const internal = await isInternalChat(pool, [thread.chat_id]);
        if (internal.rowCount !== 0) throw new Error("Internal coordination cannot be a member-facing destination");
        await deps.subagents.runtime.writeEntry(thread.chat_id, {
          ...agentMessageEntry(agent.org_id, agent.model, String(args["text"])),
          data: { request_id: uuidv5(agent.id, `reply:${callId}`) },
        });
        if (typeof args["surface_thread_id"] === "string") {
          await store.threads.surfaceThread(args["surface_thread_id"], origin.user_id);
        }
        return { delivered: true, thread_id: thread.id, user_id: origin.user_id };
      },
    ),
    tool(
      "schedule_wake",
      "Schedule a future coordinator input, not a Routine. Use ISO time and a reason; multiple independent wakes are supported.",
      { input_id: str, at: str, reason: str },
      ["input_id", "at", "reason"],
      async (args, callId) => {
        const origin = await source(args["input_id"]);
        const at = new Date(String(args["at"]));
        if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
          throw new Error("at must be a future ISO timestamp");
        const id = uuidv5(agent.id, `wake:${callId}`);
        await insertCoordinatorWake(pool, [
          id,
          agent.id,
          origin.user_id,
          origin.source_thread_id,
          JSON.stringify({ reason: String(args["reason"]), source_input_id: origin.id }),
          at,
        ]);
        return { wake_id: id, at: at.toISOString() };
      },
    ),
    tool(
      "create_routine",
      "Create scheduled worker work for this Agent. Its findings reach coordination. This is distinct from schedule_wake.",
      { input_id: str, name: str, schedule: str, timezone: str, prompt: str },
      ["input_id", "name", "schedule", "prompt"],
      async (args, callId, api, context) => {
        const member = await routineManager(args["input_id"], api, context);
        return createRoutine(pool, agent.id, {
          id: uuidv5(agent.id, `routine:${callId}`),
          created_by_user_id: member.id,
          name: String(args["name"]),
          kind: "cron",
          schedule: String(args["schedule"]),
          timezone: typeof args["timezone"] === "string" ? args["timezone"] : "UTC",
          prompt: String(args["prompt"]),
        });
      },
    ),
    tool("list_routines", "List this Agent's scheduled worker work.", {}, [], async () => listRoutines(pool, agent.id)),
    tool(
      "update_routine",
      "Update this Agent's routine using an input_id from a Member with manage access.",
      { input_id: str, routine_id: str, prompt: str, schedule: str, enabled: { type: "boolean" } },
      ["input_id", "routine_id"],
      async (args, _callId, api, context) => {
        await routineManager(args["input_id"], api, context);
        await getRoutine(pool, agent.id, String(args["routine_id"]));
        return updateRoutine(pool, agent.id, String(args["routine_id"]), {
          ...(typeof args["prompt"] === "string" ? { prompt: args["prompt"] } : {}),
          ...(typeof args["schedule"] === "string" ? { schedule: args["schedule"] } : {}),
          ...(typeof args["enabled"] === "boolean" ? { enabled: args["enabled"] } : {}),
        });
      },
    ),
    tool(
      "delete_routine",
      "Remove this Agent's routine using an input_id from a Member with manage access.",
      { input_id: str, routine_id: str },
      ["input_id", "routine_id"],
      async (args, _callId, api, context) => {
        await routineManager(args["input_id"], api, context);
        await deleteRoutine(pool, agent.id, String(args["routine_id"]));
        return { deleted: true };
      },
    ),
    tool(
      "list_wakes",
      "List this Agent's pending coordinator wake-ups.",
      {},
      [],
      async () => (await listCoordinatorWakes(pool, [agent.id])).rows,
    ),
    tool("cancel_wake", "Cancel one pending coordinator wake-up.", { wake_id: str }, ["wake_id"], async (args) => {
      const result = await cancelCoordinatorWake(pool, [args["wake_id"], agent.id]);
      return { cancelled: result.rowCount === 1 };
    }),
    tool(
      "conversations_list",
      "List this Agent's threads across members for coordination.",
      {},
      [],
      async () => (await listCoordinationThreads(pool, [agent.id])).rows,
    ),
    tool(
      "conversation_read",
      "Read a thread of this Agent. All members' context contributes to this Agent.",
      { thread_id: str },
      ["thread_id"],
      async (args) => {
        const thread = await store.threads.threadById(String(args["thread_id"]));
        if (thread === null || thread.agent_id !== agent.id) throw new Error("Thread does not belong to this Agent");
        return readThreadTranscript(pool, { threadId: thread.id, chatId: thread.chat_id, title: thread.title });
      },
    ),
  ];
}

export function coordinatorInstructions(agent: Agent): string {
  return `<coordinator>\nYou maintain the one persistent coordinator conversation for ${agent.name}.
Your context and Workspace are shared Agent knowledge. Inputs identify their originating member, thread and causal reference.
Reply to each direct request immediately with a short send_message acknowledgment using its input_id, before delegating longer work. Your final text is internal and is never delivered automatically.
Keep member-facing replies short. Minimize interruptions and follow each request's reporting instructions. Background results may need no message.
Delegate substantive work with spawn; omit agent for a general worker. Integrations, external research and Machine work belong to workers.
Spawn returns immediately: end your turn when only worker work remains. Worker results wake you; do not wait or poll. Trust workers to verify their substantive work; do not repeat it yourself.
Link tasks with the /thread/<chat_id> URL returned by spawn, never a thread: link or a thread_id used as a chat_id. If a task needs discussion, surface its thread and let the member converse there. Preserve origin input references in follow-ups.
Use schedule_wake for future follow-up, then finish this turn. Wakes are distinct from recurring Routines.
Standing responsibilities and learned guidance live in your Workspace. Reflection maintains memory independently.
Acting scope: ${coordinationSettings(agent).scope}. Never infer the recipient from the latest speaker.
When compacting, preserve commitments, reporting preferences, input IDs, thread IDs, pending work and causal links.
</coordinator>`;
}
