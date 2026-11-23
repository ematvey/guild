// A chat's binding to an agent thread: adoption by the caller's personal
// agent on a first turn, the composer's agent picker, the thread context the
// agent's instructions name, the run row a chat turn opens, and the name a
// fresh thread gets from its first message. The agent_threads rows these
// read and write are the agent store's; the runtime calls through here.

import type { PlatformPool } from "../platform/db.js";
import type { UserRow } from "../platform/store/identity.js";
import { refuseDeletingAgent, type AgentStore, type AgentTreeStore } from "./store.js";
import type { Agent } from "./types.js";
import {
  agentThreadForChat,
  chatThreadKind,
  chatThreadNode,
  insertUserThread,
  moveChatThread,
  spawnedByRow,
  threadContextRow,
  titleSourceRow,
} from "./store/bindings.js";
import { firstUserMessage } from "./store/events.js";

/** Thrown when a chat's thread belongs to an agent the caller cannot leave. */
export class ThreadAgentLocked extends Error {
  constructor() {
    super("This thread belongs to its agent. Start a new chat to use another agent.");
    this.name = "ThreadAgentLocked";
  }
}

/** The agent a chat turn runs on. */
export interface ChatAgentBinding {
  agent_id: string;
  thread_id: string;
  model: string;
}

/** The thread's own context: an isolated routine run, or a thread the agent
 *  opened from one of its runs. */
export interface ThreadContext {
  type: string;
  routineName: string | null;
  /** A routine run's delivery mode; null outside a routine run. */
  routineDelivery: "thread" | "new_chat" | null;
  /** The routine whose deliveries this user thread collects. */
  feedRoutineName: string | null;
  origin: { thread_id: string; title: string } | null;
}

/** The tree context of a spawned child thread. */
export interface SpawnedBy {
  parent_name: string;
  depth: number;
  can_spawn: boolean;
}

/** What a thread title is generated from. */
export interface TitleSource {
  orgId: string;
  model: string;
  firstMessage: string;
}

type BindingStore = Pick<AgentStore, "fetchAgent" | "ensurePersonalAgentFor" | "requireAccess"> & {
  readonly tree: Pick<AgentTreeStore, "childCount" | "closeSubtree">;
};

export class ThreadBinding {
  constructor(
    private readonly pool: PlatformPool,
    private readonly store: BindingStore,
    private readonly limits: { maxDepth: number; maxChildrenPerNode: number },
  ) {}

  /** Makes a plain chat an agent chat: the caller's personal agent adopts it
   *  on the first turn, so every conversation has an agent. Idempotent — a
   *  chat that already belongs to an agent keeps it. Returns the agent whose
   *  model and tools the turn must use, or null when the org has no model.
   *  A chat whose agent is being deleted refuses the turn (409). */
  async adopt(chatId: string, orgId: string, userId: string, title: string): Promise<ChatAgentBinding | null> {
    const existing = await agentThreadForChat(this.pool, chatId);
    if (existing !== null) return this.bound(existing);
    const personal = await this.store.ensurePersonalAgentFor(orgId, userId);
    if (personal === null) return null;
    const id = await insertUserThread(this.pool, { agentId: personal.id, userId, chatId, title });
    if (id === null) {
      // A concurrent turn adopted it first.
      const again = await agentThreadForChat(this.pool, chatId);
      if (again === null) throw new Error("chat adoption lost its thread");
      return this.bound(again);
    }
    return { agent_id: personal.id, thread_id: id, model: personal.model };
  }

  /** Binds a chat to a chosen agent (the composer's agent picker). A chat
   *  that already has a thread keeps its transcript and changes agent; a
   *  plain chat gets a thread on the chosen agent. An agent being deleted
   *  takes no chat (409). */
  async bind(chatId: string, userId: string, agentId: string, title: string, user: UserRow): Promise<ChatAgentBinding> {
    const { agent } = await this.store.requireAccess(user, agentId, "use");
    refuseDeletingAgent(agent);
    const existing = await agentThreadForChat(this.pool, chatId);
    if (existing !== null) {
      if (existing.agent_id !== agent.id) {
        if (!(await this.switchAllowed(chatId))) throw new ThreadAgentLocked();
        await moveChatThread(this.pool, chatId, agent.id);
      }
      return { agent_id: agent.id, thread_id: existing.thread_id, model: agent.model };
    }
    const id = await insertUserThread(this.pool, { agentId: agent.id, userId, chatId, title });
    if (id === null) {
      const again = await agentThreadForChat(this.pool, chatId);
      if (again === null) throw new Error("agent binding lost its thread");
      return { agent_id: again.agent_id, thread_id: again.thread_id, model: agent.model };
    }
    return { agent_id: agent.id, thread_id: id, model: agent.model };
  }

  /** The agent bound to a chat, for the composer's chip. */
  async agentOf(chatId: string): Promise<Agent | null> {
    const ref = await agentThreadForChat(this.pool, chatId);
    return ref === null ? null : this.store.fetchAgent(ref.agent_id);
  }

  /** A thread keeps the agent that owns it when it is a run transcript or a
   *  coordination thread (the member's assistant inbox, the coordinator's
   *  history, a reflection). Ordinary threads move with the picker. */
  async switchAllowed(chatId: string): Promise<boolean> {
    const row = await chatThreadKind(this.pool, chatId);
    if (row === null) return true;
    if (row.execution_role !== "thread") return false;
    return row.type === "user";
  }

  /** Closes the chat's agent-thread subtree (archive): in-flight runs stop
   *  and deliveries to and from the subtree stop. */
  async closeSubtree(chatId: string): Promise<void> {
    const thread = await chatThreadNode(this.pool, chatId);
    if (thread !== null) await this.store.tree.closeSubtree(thread.id);
  }

  /** The thread's own context; null for a plain thread. */
  async threadContext(chatId: string): Promise<ThreadContext | null> {
    const row = await threadContextRow(this.pool, chatId);
    if (row === null) return null;
    const origin =
      row.origin_thread_id === null ? null : { thread_id: row.origin_thread_id, title: row.origin_title ?? "" };
    if (row.type !== "routine" && origin === null && row.feed_routine_name === null) return null;
    const delivery =
      row.type !== "routine" ? null : row.routine_delivery === "new_chat" ? ("new_chat" as const) : ("thread" as const);
    return {
      type: row.type,
      routineName: row.routine_name,
      routineDelivery: delivery,
      feedRoutineName: row.feed_routine_name,
      origin,
    };
  }

  /** The tree context of a spawned child thread; undefined for a root. */
  async spawnedBy(chatId: string): Promise<SpawnedBy | undefined> {
    const row = await spawnedByRow(this.pool, chatId);
    if (row === null || row.parent_thread_id === null) return undefined;
    const children = await this.store.tree.childCount(row.thread_id);
    return {
      parent_name: row.parent_name ?? "another agent",
      depth: Number(row.depth),
      can_spawn: Number(row.depth) < this.limits.maxDepth && children < this.limits.maxChildrenPerNode,
    };
  }

  /** What a fresh thread's title is generated from: its org, its agent's
   *  model and its first user message. Null for explicitly named threads
   *  (title_locked), non-chat threads, threads that already carry a title,
   *  and threads with no text or no model. */
  async titleSource(chatId: string, threadId: string): Promise<TitleSource | null> {
    const row = await titleSourceRow(this.pool, chatId, threadId);
    if (row === null) return null;
    if (row.type !== "user" || row.title_locked) return null;
    if ((row.title ?? "").trim() !== "") return null;
    const first = await firstUserMessage(this.pool, chatId);
    const text = (first ?? "").trim();
    if (text === "" || row.model === null) return null;
    return { orgId: row.org_id, model: row.model, firstMessage: text };
  }

  private async bound(ref: { agent_id: string; thread_id: string }): Promise<ChatAgentBinding> {
    const agent = await this.store.fetchAgent(ref.agent_id);
    refuseDeletingAgent(agent);
    return { agent_id: agent.id, thread_id: ref.thread_id, model: agent.model };
  }
}
