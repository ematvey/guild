// Starting a run in an existing agent thread: the one path for subagent
// spawns and sends and for scheduled and manual routine runs. It rechecks
// the agent (active, not being deleted) and the requester's access, opens
// the run row, posts the user turn into the thread's chat, and marks the run
// failed when anything after the row fails.

import type { UserRow } from "../platform/store/identity.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { userMessageEvent } from "../platform/domain/thread-events.js";
import { uuidv7 } from "../platform/time.js";
import type { AgentRunStore, AgentStore, CreateRunInput } from "./store.js";
import type { Agent, AgentRun } from "./types.js";

export interface ThreadRunRuntime {
  submitTurn(
    chatId: string,
    orgId: string,
    input: {
      orgId: string;
      requestId: string;
      content: string;
      images: { mimeType: string; data: string }[];
      model: string | null;
    },
  ): Promise<number>;
}

export interface StartThreadRunDeps {
  store: Pick<AgentStore, "fetchAgent" | "access"> & { readonly runs: Pick<AgentRunStore, "createRun" | "updateRun"> };
  threads: Pick<ThreadStore, "appendEvent">;
  runtime: ThreadRunRuntime;
}

export interface StartThreadRunInput {
  agentId: string;
  thread: { id: string; chat_id: string };
  /** The run row's remaining fields; agent, thread, status and start time
   *  are filled here. */
  run: Omit<CreateRunInput, "agent_id" | "thread_id" | "status">;
  /** The user turn posted into the thread. */
  content: string;
  /** When set, this user must be able to use the agent. */
  requester?: UserRow;
  /** The run's error_code when the turn cannot be posted. */
  failureCode: string;
  /** Records the error stack with the message on the failed run. */
  recordStack?: boolean;
  /** Runs once the run row exists, before the turn is posted. */
  onRunCreated?: (run: AgentRun) => Promise<void>;
}

export type ThreadRunRefusal = "agent_deleting" | "agent_inactive" | "forbidden";

/** The agent cannot take this run; no run row was written. */
export class ThreadRunRefused extends Error {
  constructor(
    readonly code: ThreadRunRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ThreadRunRefused";
  }
}

/** The turn could not be posted; the run row is marked failed. */
export class ThreadRunSubmitFailed extends Error {
  constructor(
    readonly run: AgentRun,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ThreadRunSubmitFailed";
  }
}

/** Gates on a fresh read of the agent, opens the run and posts the turn.
 *  Returns the running run and the agent it ran as. */
export async function startThreadRun(
  deps: StartThreadRunDeps,
  input: StartThreadRunInput,
): Promise<{ run: AgentRun; agent: Agent }> {
  const agent = await deps.store.fetchAgent(input.agentId);
  if (agent.status === "deleting" || agent.status === "deleted") {
    throw new ThreadRunRefused("agent_deleting", "this agent is being deleted; its threads are read-only");
  }
  if (agent.status !== "active") throw new ThreadRunRefused("agent_inactive", "agent is not active");
  if (input.requester !== undefined) {
    const access = await deps.store.access(input.requester, agent);
    if (!access.can_use) throw new ThreadRunRefused("forbidden", "the requester cannot use the target agent");
  }
  const run = await deps.store.runs.createRun({
    ...input.run,
    agent_id: agent.id,
    thread_id: input.thread.id,
    status: "running",
    started_at: input.run.started_at ?? new Date().toISOString(),
  });
  try {
    await input.onRunCreated?.(run);
    await deps.threads.appendEvent(input.thread.chat_id, userMessageEvent(input.content));
    await deps.runtime.submitTurn(input.thread.chat_id, agent.org_id, {
      orgId: agent.org_id,
      requestId: uuidv7(),
      content: input.content,
      images: [],
      model: agent.model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      input.recordStack === true && error instanceof Error && error.stack ? `${message}\n${error.stack}` : message;
    await deps.store.runs
      .updateRun(run.id, {
        status: "failed",
        error_code: input.failureCode,
        error_message: detail,
        finished_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw new ThreadRunSubmitFailed(run, error);
  }
  return { run, agent };
}
