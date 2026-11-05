import type { JsonObject, TaskRecord } from "@earendil-works/pi-durable";
import type { PostgresExecutor } from "./executor.js";

type Task = TaskRecord<JsonObject, JsonObject, JsonObject>;
const active = (task: Task): boolean => task.state.status !== "terminal";
const checkpoint = (task: Task): JsonObject => ("checkpoint" in task.state ? (task.state.checkpoint ?? {}) : {});

/** Rebuild presentation and run ownership from durable tasks and placed inputs.
 * Queued and terminal submissions are never admitted or settled by repair. */
export async function rebuildLiveProjection(tx: PostgresExecutor, conversationId: number): Promise<JsonObject> {
  const tasks = (
    await tx.query<{ record: string }>("SELECT record FROM tasks WHERE conversation_id=$1 ORDER BY id", [
      conversationId,
    ])
  ).map((row) => JSON.parse(row.record) as Task);
  const runs = tasks.filter((task) => task.kind === "pi.generation" && active(task));
  const inputs = await tx.query<{ id: number }>(
    "SELECT id FROM submissions WHERE conversation_id=$1 AND status='placed' ORDER BY id",
    [conversationId],
  );
  if (runs.length > 1 || (runs.length === 0 && inputs.length > 0)) {
    throw new Error(`Cannot reconstruct live run ownership for conversation ${conversationId}`);
  }
  const live: JsonObject = {};
  const run = runs[0];
  if (run) {
    live.run = { taskId: run.id, inputs: inputs.map((row) => Number(row.id)), turns: 0 };
    const state = checkpoint(run);
    if (state.phase !== "tools") {
      live.generation = { attempt: typeof state.attempt === "number" ? state.attempt : 1 };
      if (state.phase === "retry" && typeof state.until === "number") {
        (live.generation as JsonObject).retry = { at: state.until, error: "Restored generation retry" };
      }
      if (state.phase === "poll" && typeof state.pollAt === "number") {
        (live.generation as JsonObject).deferred = { pollAt: state.pollAt };
      }
    } else {
      const rows = await tx.query<{ record: string }>("SELECT record FROM entries WHERE id=$1 AND conversation_id=$2", [
        state.assistant as number,
        conversationId,
      ]);
      const entry = rows[0] ? JSON.parse(rows[0].record) : undefined;
      const calls: { id: string; name: string }[] = (entry?.model?.[0]?.content ?? []).filter(
        (block: { type: string }) => block.type === "toolCall",
      );
      if (calls.length === 0) throw new Error(`Cannot reconstruct tool round for conversation ${conversationId}`);
      live.tools = calls.map((call) => {
        const task = tasks.find(
          (task) => task.kind === "pi.tool" && task.owner === run.id && task.input.callId === call.id,
        );
        const slot: JsonObject = {
          callId: call.id,
          name: call.name,
          status: task ? (active(task) ? "running" : "done") : "pending",
        };
        if (task) {
          slot.taskId = task.id;
          if (task.state.status === "terminal" && task.state.outcome.status === "completed") {
            const entryId = task.state.outcome.result.entryId;
            if (typeof entryId === "number") slot.entry = entryId;
          }
        }
        return slot;
      });
      const parents = new Set(
        tasks.filter((task) => task.owner === run.id && active(task)).map((task) => Number(task.id)),
      );
      const nested: JsonObject[] = [];
      for (const task of tasks) {
        if (task.kind !== "pi.tool" || task.input.kind !== "nested" || !parents.has(task.input.parent as number))
          continue;
        const call = task.input.call as JsonObject;
        if (!call || typeof call.id !== "string" || typeof call.name !== "string")
          throw new Error(`Invalid nested call ${task.id}`);
        nested.push({
          taskId: task.id,
          parentTaskId: task.input.parent!,
          parentCallId: task.input.parentCallId!,
          callId: call.id,
          name: call.name,
          arguments: checkpoint(task).arguments ?? call.arguments ?? {},
          status: active(task) ? "running" : "done",
        });
        if (active(task)) parents.add(Number(task.id));
      }
      if (nested.length) live.nestedTools = nested;
    }
  }
  const compactions = tasks.filter((task) => task.kind === "pi.compaction" && active(task));
  if (compactions.length)
    live.compactions = compactions.map((task) => ({
      taskId: task.id,
      trigger: task.input.reason ?? "manual",
      blocking: task.owner !== undefined,
      attempt: checkpoint(task).attempt ?? 1,
    }));
  return live;
}
