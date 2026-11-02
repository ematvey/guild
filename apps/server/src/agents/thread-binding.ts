// A chat's binding to an agent thread: adoption by the caller's personal
// agent on a first turn, the composer's agent picker, the thread context the
// agent's instructions name, the run row a chat turn opens, and the name a
// fresh thread gets from its first message. The agent_threads rows these
// read and write are the agent store's; the runtime calls through here.

import type { PlatformPool } from "../platform/db.js";
import type { UserRow } from "../platform/store/identity.js";
import { uuidv7 } from "../platform/time.js";
import { refuseDeletingAgent, type AgentRunStore, type AgentStore, type AgentTreeStore } from "./store.js";
import type { Agent } from "./types.js";
import { agentThreadForChat } from "./workspace.js";

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
  readonly runs: Pick<AgentRunStore, "createRun" | "updateRun" | "runningRunForThread">;
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
    const id = await this.insertUserThread(personal.id, userId, chatId, title);
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
        await this.pool.query(
          `UPDATE agent_threads SET agent_id = $2, last_activity_at = now()
           WHERE chat_id = $1`,
          [chatId, agent.id],
        );
      }
      return { agent_id: agent.id, thread_id: existing.thread_id, model: agent.model };
    }
    const id = await this.insertUserThread(agent.id, userId, chatId, title);
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

  /** A thread keeps the agent that owns it when it is that agent's Main
   *  thread or a run transcript. Ordinary threads move with the picker. */
  async switchAllowed(chatId: string): Promise<boolean> {
    const res = await this.pool.query<{ type: string; is_default: boolean }>(
      "SELECT type, is_default FROM agent_threads WHERE chat_id = $1",
      [chatId],
    );
    const row = res.rows[0];
    return row === undefined || (row.type === "user" && !row.is_default);
  }

  /** Closes the chat's agent-thread subtree (archive): in-flight runs stop
   *  and deliveries to and from the subtree stop. */
  async closeSubtree(chatId: string): Promise<void> {
    const res = await this.pool.query<{ id: string }>("SELECT id FROM agent_threads WHERE chat_id = $1", [chatId]);
    if (res.rows[0] !== undefined) await this.store.tree.closeSubtree(res.rows[0].id);
  }

  /** The thread's own context; null for a plain thread. */
  async threadContext(chatId: string): Promise<ThreadContext | null> {
    const res = await this.pool.query<{
      type: string;
      origin_thread_id: string | null;
      origin_title: string | null;
      routine_name: string | null;
    }>(
      `SELECT t.type, t.origin_thread_id,
              (SELECT o.title FROM agent_threads o WHERE o.id = t.origin_thread_id) AS origin_title,
              (SELECT r.name FROM agent_runs rn JOIN agent_routines r ON r.id = rn.routine_id
               WHERE rn.thread_id = t.id AND rn.trigger = 'routine'
               ORDER BY rn.created_at DESC LIMIT 1) AS routine_name
       FROM agent_threads t
       WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    const origin =
      row.origin_thread_id === null ? null : { thread_id: row.origin_thread_id, title: row.origin_title ?? "" };
    if (row.type !== "routine" && origin === null) return null;
    return { type: row.type, routineName: row.routine_name, origin };
  }

  /** The tree context of a spawned child thread; undefined for a root. */
  async spawnedBy(chatId: string): Promise<SpawnedBy | undefined> {
    const res = await this.pool.query<{
      thread_id: string;
      parent_thread_id: string | null;
      depth: number;
      parent_name: string | null;
    }>(
      `SELECT t.id AS thread_id, t.parent_thread_id, t.depth, pa.name AS parent_name
       FROM agent_threads t
       LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id
       LEFT JOIN agents pa ON pa.id = pt.agent_id
       WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0];
    if (row === undefined || row.parent_thread_id === null) return undefined;
    const children = await this.store.tree.childCount(row.thread_id);
    return {
      parent_name: row.parent_name ?? "another agent",
      depth: Number(row.depth),
      can_spawn: Number(row.depth) < this.limits.maxDepth && children < this.limits.maxChildrenPerNode,
    };
  }

  /** Opens the run row for a chat turn; the run lifecycle closes it from
   *  the transcript like any other agent turn. A run a delivery opened for
   *  the thread while the chat had no live turn is adopted: a second run
   *  would stay open forever. */
  async beginChatRun(agentId: string, threadId: string, userId: string): Promise<string> {
    const open = await this.store.runs.runningRunForThread(threadId);
    if (open !== null) {
      if (open.status === "queued") {
        await this.store.runs.updateRun(open.id, { status: "running", started_at: new Date().toISOString() });
      }
      return open.id;
    }
    return this.beginMessageRun({ agent_id: agentId, user_id: userId, id: threadId });
  }

  /** Creates a running message-triggered run on a thread (a chat turn, or a
   *  child result delivered to an idle parent). */
  async beginMessageRun(thread: { id: string; agent_id: string; user_id: string; depth?: number }): Promise<string> {
    const run = await this.store.runs.createRun({
      agent_id: thread.agent_id,
      user_id: thread.user_id,
      thread_id: thread.id,
      ...(thread.depth === undefined ? {} : { depth: thread.depth }),
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    return run.id;
  }

  /** What a fresh thread's title is generated from: its org, its agent's
   *  model and its first user message. Null for explicitly named threads
   *  (title_locked), non-chat threads, threads that already carry a title,
   *  and threads with no text or no model. */
  async titleSource(chatId: string, threadId: string): Promise<TitleSource | null> {
    const res = await this.pool.query<{
      org_id: string;
      title: string | null;
      title_locked: boolean;
      type: string;
      is_default: boolean;
      model: string | null;
    }>(
      `SELECT c.org_id, t.title, t.title_locked, t.type, t.is_default, a.model
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       JOIN agents a ON a.id = t.agent_id
       WHERE t.id = $1 AND t.chat_id = $2`,
      [threadId, chatId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    if (row.type !== "user" || row.is_default || row.title_locked) return null;
    if ((row.title ?? "").trim() !== "") return null;
    const first = await this.pool.query<{ content: string | null }>(
      `SELECT payload->>'content' AS content FROM thread_events
       WHERE chat_id = $1 AND type = 'user_message' ORDER BY seq ASC LIMIT 1`,
      [chatId],
    );
    const text = (first.rows[0]?.content ?? "").trim();
    if (text === "" || row.model === null) return null;
    return { orgId: row.org_id, model: row.model, firstMessage: text };
  }

  private async bound(ref: { agent_id: string; thread_id: string }): Promise<ChatAgentBinding> {
    const agent = await this.store.fetchAgent(ref.agent_id);
    refuseDeletingAgent(agent);
    return { agent_id: agent.id, thread_id: ref.thread_id, model: agent.model };
  }

  /** Inserts the chat's user thread; null when another one won the race. */
  private async insertUserThread(
    agentId: string,
    userId: string,
    chatId: string,
    title: string,
  ): Promise<string | null> {
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, type)
       VALUES ($1, $2, $3, $4, $5, false, 'user')
       ON CONFLICT (chat_id) DO NOTHING
       RETURNING id`,
      [uuidv7(), agentId, userId, chatId, title],
    );
    return inserted.rows[0]?.id ?? null;
  }
}
