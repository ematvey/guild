// Agent and skill state on the member socket: the agent list, one run, one
// agent's routines, one user's threads with an agent, and the skill catalog.
// Each frame is scoped to the users allowed to read it — an agent's run and
// routines reach only members who may see that agent, a thread list only its
// owner, an agent list is filtered per member — and carries the whole current
// value, so the client replaces (or, for a run, upserts) and never re-fetches.
// Table triggers NOTIFY every write (migrations/0101_agent_notify.sql, and
// 0102 for an agent rename, which moves its threads' chat trees); each
// key's pushes run on one chain, so a snapshot read before a write never
// lands after the one read after it.

import type { PlatformContext } from "../platform/root-context.js";
import { AgentStore } from "../agents/store.js";
import type { Agent as StoreAgent, AgentRoutine as StoreRoutine, AgentRun as StoreRun } from "../agents/types.js";
import type { Agent, AgentRoutine, AgentRun } from "@guild/wire/rest";
import type { WsServerMsg } from "./protocol.js";

/** The NOTIFY channels this feed consumes. */
export const AGENT_STATE_CHANNELS: ReadonlySet<string> = new Set([
  "guild_agents",
  "guild_agent_runs",
  "guild_agent_routines",
  "guild_agent_threads",
  "guild_skills",
]);

type Failed = (channel: string, error: unknown) => void;

/** An agent row on the wire: every joined field is always present. */
export function agentWire(agent: StoreAgent): Agent {
  return {
    ...agent,
    owner_label: agent.owner_label ?? null,
    owner_email: agent.owner_email ?? null,
    owner_avatar_url: agent.owner_avatar_url ?? null,
    model_alias: agent.model_alias ?? null,
    team_ids: agent.team_ids ?? [],
  };
}

/** A run row on the wire: the joined display names are always present. */
export function runWire(run: StoreRun): AgentRun {
  return { ...run, agent_name: run.agent_name ?? null, routine_name: run.routine_name ?? null };
}

function routineWire(routine: StoreRoutine): AgentRoutine {
  return { ...routine, last_run: routine.last_run ? runWire(routine.last_run) : null };
}

function stringField(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" ? value : null;
}

export class AgentStateFeed {
  private agentStore: AgentStore | null = null;
  private readonly chains = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly failed: Failed,
  ) {}

  /** The agent reads, built on first use: a feed that never sees an agent
   *  channel needs no store. */
  private get store(): AgentStore {
    this.agentStore ??= new AgentStore(this.ctx.pool, this.ctx.trace, this.ctx.config.agentWorkspaceWriteRoot);
    return this.agentStore;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Handles one NOTIFY; false when the channel is not an agent or skill
   *  channel. */
  onNotify(channel: string, payload: string): boolean {
    if (!AGENT_STATE_CHANNELS.has(channel)) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return true;
    }
    if (parsed === null || typeof parsed !== "object") return true;
    const orgId = stringField(parsed, "org_id");
    if (orgId === null) return true;
    const agentId = stringField(parsed, "agent_id");
    switch (channel) {
      case "guild_agents":
        void this.enqueue(`agents:${orgId}`, channel, () =>
          this.sendAgentLists(orgId, this.ctx.hub.memberUsersOfOrg(orgId), false),
        );
        break;
      case "guild_skills":
        void this.enqueue(`skills:${orgId}`, channel, () =>
          this.sendSkillCatalogs(orgId, this.ctx.hub.memberUsersOfOrg(orgId)),
        );
        break;
      case "guild_agent_runs": {
        const runId = stringField(parsed, "run_id");
        if (agentId === null || runId === null) break;
        void this.enqueue(`agent:${agentId}`, channel, () => this.sendRun(orgId, agentId, runId));
        break;
      }
      case "guild_agent_routines":
        if (agentId === null) break;
        void this.enqueue(`agent:${agentId}`, channel, () => this.sendRoutines(orgId, agentId));
        break;
      case "guild_agent_threads": {
        const userId = stringField(parsed, "user_id");
        if (agentId === null || userId === null) break;
        void this.enqueue(`threads:${userId}:${agentId}`, channel, () => this.sendThreads(userId, agentId));
        break;
      }
    }
    return true;
  }

  /** A new member socket's first paint: the member's agent list (their
   *  personal agent exists from here on) and the skill catalog. */
  connect(orgId: string, userId: string): Promise<void> {
    return Promise.all([
      this.enqueue(`agents:${orgId}`, "connect", () => this.sendAgentLists(orgId, [userId], true)),
      this.enqueue(`skills:${orgId}`, "connect", () => this.sendSkillCatalogs(orgId, [userId])),
    ]).then(() => {});
  }

  private async sendAgentLists(orgId: string, userIds: string[], ensurePersonal: boolean): Promise<void> {
    for (const userId of userIds) {
      if (!this.connected(userId)) continue;
      let user;
      try {
        user = await this.ctx.identity.getUser(userId);
      } catch {
        continue;
      }
      if (user.org_id !== orgId) continue;
      if (ensurePersonal) await this.store.ensurePersonalAgent(user);
      const agents = (await this.store.list(user, { includeArchived: true })).map(agentWire);
      this.send(userId, { type: "agent_list", agents });
    }
  }

  private async sendRun(orgId: string, agentId: string, runId: string): Promise<void> {
    const users = this.ctx.hub.memberUsersOfOrg(orgId);
    if (users.length === 0) return;
    const viewers = await this.store.visibleUserIds(agentId, users);
    if (viewers.length === 0) return;
    let run: StoreRun;
    try {
      run = await this.store.getRun(runId);
    } catch {
      return;
    }
    const frame: WsServerMsg = { type: "agent_run", run: runWire(run) };
    for (const userId of viewers) this.send(userId, frame);
  }

  private async sendRoutines(orgId: string, agentId: string): Promise<void> {
    const users = this.ctx.hub.memberUsersOfOrg(orgId);
    if (users.length === 0) return;
    const viewers = await this.store.visibleUserIds(agentId, users);
    if (viewers.length === 0) return;
    const routines = (await this.store.listRoutines(agentId)).map(routineWire);
    const frame: WsServerMsg = { type: "agent_routines", agent_id: agentId, routines };
    for (const userId of viewers) this.send(userId, frame);
  }

  private async sendThreads(userId: string, agentId: string): Promise<void> {
    if (!this.connected(userId)) return;
    const page = await this.store.listThreads(agentId, userId);
    this.send(userId, { type: "agent_threads", agent_id: agentId, threads: page.threads });
  }

  private async sendSkillCatalogs(orgId: string, userIds: string[]): Promise<void> {
    const members = userIds.filter((userId) => this.connected(userId));
    if (members.length === 0) return;
    const items = await this.ctx.skills.catalog(orgId, null);
    for (const userId of members) {
      const installs = await this.ctx.skills.listForUser(orgId, userId);
      this.send(userId, { type: "skill_catalog", items, installs });
    }
  }

  private connected(userId: string): boolean {
    return this.ctx.hub.memberSinksOfUser(userId).length > 0;
  }

  private send(userId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.memberSinksOfUser(userId)) sink.send(frame);
  }

  /** Serializes one key's pushes; a failed push is logged and the chain
   *  moves on (the next change re-sends the whole value). */
  private enqueue(key: string, channel: string, op: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => (this.stopped ? undefined : op()))
      .catch((error: unknown) => this.failed(channel, error));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }
}
