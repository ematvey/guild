// Agent and skill state on the member socket: the agent list, the
// Integrations a member may attach, one run, one agent's routines, one
// user's threads with an agent, and the skill catalog.
// Each frame is scoped to the users allowed to read it — an agent's run and
// routines reach only members who may see that agent, a thread list only its
// owner, an agent list is filtered per member — and carries the whole current
// value, so the client replaces (or, for a run, upserts) and never re-fetches.
// Table triggers NOTIFY every write (migrations/0101_agent_notify.sql, and
// 0102 for an agent rename, which moves its threads' chat trees); each
// key's pushes run on one chain, so a snapshot read before a write never
// lands after the one read after it. The org-wide lists coalesce a write
// burst into one re-read. A whole-value frame reaches a socket
// only when it differs from the one that socket holds: a write another member
// cannot see sends that member nothing.

import type {
  AgentGrants,
  AgentRunStore,
  AgentStore,
  AgentThreadStore,
} from "../agents/store.js";
import { wireThread } from "../agents/store.js";
import type {
  Agent as StoreAgent,
  AgentRoutine as StoreRoutine,
  AgentRun as StoreRun,
} from "../agents/types.js";
import type { Agent, AgentRoutine, AgentRun } from "@guild/wire/rest";
import type { OrgPayload } from "../platform/notify.js";
import type { IdentityStore } from "../platform/store/identity.js";
import type { SkillStore } from "../platform/store/skills.js";
import type { AppStore } from "../platform/store/apps.js";
import type { TraceStore } from "../platform/trace.js";
import type { LiveHub } from "./live.js";
import type { WsServerMsg } from "./protocol.js";
import { sendChanged } from "./sent-frames.js";
import { KeyedChain, type ChainFailure } from "./keyed-chain.js";
import type { IntegrationAccessStore } from "../platform/store/integration-access.js";
import {
  agentIntegrations,
  agentWarnings,
  type AccessContext,
  type IntegrationDisplay,
} from "../platform/domain/integration-access.js";

/** The reads the agent and skill frames take. */
export interface AgentStateDeps {
  readonly hub: Pick<LiveHub, "memberUsersOfOrg" | "memberSinksOfUser">;
  /** The process's one agent store. */
  readonly agents: Pick<AgentStore, "ensurePersonalAgent" | "listForOrg"> & {
    readonly grants: Pick<AgentGrants, "visibleUserIds" | "visibleAgentIds">;
    readonly runs: Pick<AgentRunStore, "getRun" | "listRoutines">;
    readonly threads: Pick<AgentThreadStore, "displayThreads">;
  };
  readonly identity: Pick<IdentityStore, "getUsers">;
  readonly skills: Pick<SkillStore, "catalog" | "installsForUsers">;
  /** The Apps each member sees. */
  readonly apps: Pick<AppStore, "listVisible">;
  readonly trace: Pick<TraceStore, "callCounts">;
  /** Integration audiences: each Agent's warnings and each member's
   *  attachable Integrations. */
  readonly integrationAccess: Pick<
    IntegrationAccessStore,
    "context" | "attachable"
  >;
  /** Installed Integrations' titles and summaries, keyed by slug. */
  integrationDisplay(orgId: string): Promise<Map<string, IntegrationDisplay>>;
}

/** How long a finished run's frame waits for its call counts. */
const COUNTS_TIMEOUT_MS = 2_000;

/** An org-wide list (agents, skill catalog) re-reads once per write burst:
 *  the push waits for a quiet window after the latest notify, and never
 *  longer than the cap after the first. One skill publish writes several
 *  rows in separate statements; its notifies become one frame per user. */
export const BURST_QUIET_MS = 50;
export const BURST_MAX_MS = 250;

/** An agent row on the wire: every joined field is always present, an
 *  `all`-tools Agent carries its derived Integration list, and the
 *  Integration warnings are computed against the org's audiences. */
export function agentWire(agent: StoreAgent, access: AccessContext): Agent {
  const integrations = agentIntegrations(agent, access);
  return {
    ...agent,
    integrations,
    owner_label: agent.owner_label ?? null,
    owner_email: agent.owner_email ?? null,
    owner_avatar_url: agent.owner_avatar_url ?? null,
    model_alias: agent.model_alias ?? null,
    team_ids: agent.team_ids ?? [],
    integration_warnings: agentWarnings({ ...agent, integrations }, access),
  };
}

/** A run row on the wire: the joined display names are always present. */
export function runWire(run: StoreRun): AgentRun {
  return {
    ...run,
    agent_name: run.agent_name ?? null,
    routine_name: run.routine_name ?? null,
  };
}

function routineWire(routine: StoreRoutine): AgentRoutine {
  return {
    ...routine,
    last_run: routine.last_run ? runWire(routine.last_run) : null,
  };
}

export class AgentStateFeed {
  private readonly chains: KeyedChain;
  private readonly bursts = new Map<
    string,
    { first: number; timer: NodeJS.Timeout }
  >();
  private stopped = false;

  constructor(
    private readonly ctx: AgentStateDeps,
    failed: ChainFailure,
  ) {
    this.chains = new KeyedChain(failed);
  }

  private get store(): AgentStateDeps["agents"] {
    return this.ctx.agents;
  }

  stop(): void {
    this.stopped = true;
    this.chains.stop();
    for (const burst of this.bursts.values()) clearTimeout(burst.timer);
    this.bursts.clear();
  }

  /** Resolves once no push is queued or running; FeedForwarder.idle(). */
  idle(): Promise<void> {
    return this.chains.idle();
  }

  /** True while a push is queued or running. */
  pushing(): boolean {
    return this.chains.active;
  }

  /** True while a write burst waits for its quiet window. */
  coalescing(): boolean {
    return this.bursts.size > 0;
  }

  /** Runs `push` once per write burst on `key` (BURST_QUIET_MS after the
   *  latest call, at most BURST_MAX_MS after the first). */
  private coalesce(key: string, push: () => Promise<void>): void {
    if (this.stopped) return;
    const now = Date.now();
    const burst = this.bursts.get(key);
    const first = burst?.first ?? now;
    if (burst !== undefined) clearTimeout(burst.timer);
    const delay = Math.max(
      0,
      Math.min(BURST_QUIET_MS, first + BURST_MAX_MS - now),
    );
    const timer = setTimeout(() => {
      this.bursts.delete(key);
      void push();
    }, delay);
    this.bursts.set(key, { first, timer });
  }

  /** `guild_agents`: an agent row moved; every member's list re-reads. */
  agents({ org_id: orgId }: OrgPayload): void {
    this.coalesce(`agents:${orgId}`, () =>
      this.chains.run(`agents:${orgId}`, "guild_agents", () =>
        this.sendAgentLists(orgId, this.ctx.hub.memberUsersOfOrg(orgId), false),
      ),
    );
  }

  /** `guild_skills`: the org's catalog or a member's installs moved. */
  skills({ org_id: orgId }: OrgPayload): void {
    this.coalesce(`skills:${orgId}`, () =>
      this.chains.run(`skills:${orgId}`, "guild_skills", () =>
        this.sendSkillCatalogs(orgId, this.ctx.hub.memberUsersOfOrg(orgId)),
      ),
    );
  }

  /** `guild_apps`: an App was published, shared, unshared or deleted;
   *  every member's list re-reads. */
  apps({ org_id: orgId }: OrgPayload): void {
    this.coalesce(`apps:${orgId}`, () =>
      this.chains.run(`apps:${orgId}`, "guild_apps", () =>
        this.sendAppLists(orgId, this.ctx.hub.memberUsersOfOrg(orgId)),
      ),
    );
  }

  /** `guild_agent_runs`: one run row moved. */
  run({ org_id: orgId, agent_id: agentId, run_id: runId }: OrgPayload): void {
    if (agentId === null || runId === null) return;
    void this.chains.run(`agent:${agentId}`, "guild_agent_runs", () =>
      this.sendRun(orgId, agentId, runId),
    );
  }

  /** `guild_agent_routines`: one agent's routines moved. */
  routines({ org_id: orgId, agent_id: agentId }: OrgPayload): void {
    if (agentId === null) return;
    void this.chains.run(`agent:${agentId}`, "guild_agent_routines", () =>
      this.sendRoutines(orgId, agentId),
    );
  }

  /** `guild_agent_threads`: one user's threads with one agent moved. */
  threads({ agent_id: agentId, user_id: userId }: OrgPayload): void {
    if (agentId === null || userId === null) return;
    void this.chains.run(
      `threads:${userId}:${agentId}`,
      "guild_agent_threads",
      () => this.sendThreads(userId, agentId),
    );
  }

  /** A new member socket's first paint: the member's agent list (their
   *  personal agent exists from here on), the skill catalog and the Apps. */
  connect(orgId: string, userId: string): Promise<void> {
    return Promise.all([
      this.chains.run(`agents:${orgId}`, "connect", () =>
        this.sendAgentLists(orgId, [userId], true),
      ),
      this.chains.run(`skills:${orgId}`, "connect", () =>
        this.sendSkillCatalogs(orgId, [userId]),
      ),
      this.chains.run(`apps:${orgId}`, "connect", () =>
        this.sendAppLists(orgId, [userId]),
      ),
    ]).then(() => {});
  }

  /** Each connected member's filtered agent list. The member rows, the
   *  members' visible agent ids and the org's agent rows load in one read
   *  each, whatever the member count; each list keeps the org rows' order.
   *  A member who left the org or was deleted gets nothing. */
  private async sendAgentLists(
    orgId: string,
    userIds: string[],
    ensurePersonal: boolean,
  ): Promise<void> {
    const connected = userIds.filter((userId) => this.connected(userId));
    if (connected.length === 0) return;
    const members = (await this.ctx.identity.getUsers(connected)).filter(
      (user) => user.org_id === orgId,
    );
    if (members.length === 0) return;
    if (ensurePersonal) {
      for (const user of members) await this.store.ensurePersonalAgent(user);
    }
    const memberIds = members.map((user) => user.id);
    const [visible, rows, access, display] = await Promise.all([
      this.store.grants.visibleAgentIds(orgId, memberIds),
      this.store.listForOrg(orgId, { includeArchived: true }),
      this.ctx.integrationAccess.context(orgId),
      this.ctx.integrationDisplay(orgId),
    ]);
    const attachable = await this.ctx.integrationAccess.attachable(
      orgId,
      memberIds,
      (slug) => display.get(slug),
    );
    const wire = rows.map((row) => agentWire(row, access));
    for (const user of members) {
      if (!this.connected(user.id)) continue;
      const levels = visible.get(user.id);
      const agents =
        levels === undefined
          ? []
          : wire
              .filter((agent) => levels.has(agent.id))
              .map((agent) => ({
                ...agent,
                can_manage: levels.get(agent.id) === "edit",
              }));
      this.sendKeyed(user.id, "agent_list", { type: "agent_list", agents });
      this.sendKeyed(user.id, "integration_access", {
        type: "integration_access",
        integrations: attachable.get(user.id) ?? [],
      });
    }
  }

  private async sendRun(
    orgId: string,
    agentId: string,
    runId: string,
  ): Promise<void> {
    const users = this.ctx.hub.memberUsersOfOrg(orgId);
    if (users.length === 0) return;
    const viewers = await this.store.grants.visibleUserIds(agentId, users);
    if (viewers.length === 0) return;
    let run: StoreRun;
    try {
      run = await this.store.runs.getRun(runId);
    } catch {
      return;
    }
    if (run.internal) return;
    const wire = runWire(run);
    if (run.finished_at !== null)
      Object.assign(wire, await this.callCounts(orgId, runId));
    const frame: WsServerMsg = { type: "agent_run", run: wire };
    for (const userId of viewers) {
      if (run.user_id === userId) this.send(userId, frame);
    }
  }

  /** A finished run's model and tool call counts, from the same spans the
   *  trace list counts. Unreachable analytics leave the counts out: the
   *  frame still goes, and the client keeps the counts it has. */
  private async callCounts(
    orgId: string,
    runId: string,
  ): Promise<{ call_count?: number; tool_count?: number }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), COUNTS_TIMEOUT_MS);
    });
    try {
      return (
        (await Promise.race([
          this.ctx.trace.callCounts(orgId, runId),
          timeout,
        ])) ?? {}
      );
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendRoutines(orgId: string, agentId: string): Promise<void> {
    const users = this.ctx.hub.memberUsersOfOrg(orgId);
    if (users.length === 0) return;
    const viewers = await this.store.grants.visibleUserIds(agentId, users);
    if (viewers.length === 0) return;
    const routines = (await this.store.runs.listRoutines(agentId)).map(
      routineWire,
    );
    const frame: WsServerMsg = {
      type: "agent_routines",
      agent_id: agentId,
      routines,
    };
    for (const userId of viewers)
      this.sendKeyed(userId, `agent_routines:${agentId}`, frame);
  }

  private async sendThreads(userId: string, agentId: string): Promise<void> {
    if (!this.connected(userId)) return;
    const viewers = await this.store.grants.visibleUserIds(agentId, [userId]);
    if (viewers.length === 0) return;
    const threads = (await this.store.threads.displayThreads(agentId, userId)).map(wireThread);
    this.sendKeyed(userId, `agent_threads:${agentId}`, {
      type: "agent_threads",
      agent_id: agentId,
      threads,
    });
  }

  private async sendSkillCatalogs(
    orgId: string,
    userIds: string[],
  ): Promise<void> {
    const members = userIds.filter((userId) => this.connected(userId));
    if (members.length === 0) return;
    const [items, installs] = await Promise.all([
      this.ctx.skills.catalog(orgId, null),
      this.ctx.skills.installsForUsers(orgId, members),
    ]);
    for (const userId of members) {
      this.sendKeyed(userId, "skill_catalog", {
        type: "skill_catalog",
        items,
        installs: installs.get(userId) ?? [],
      });
    }
  }

  private async sendAppLists(orgId: string, userIds: string[]): Promise<void> {
    const members = userIds.filter((userId) => this.connected(userId));
    if (members.length === 0) return;
    const lists = await this.ctx.apps.listVisible(orgId, members);
    for (const userId of members) {
      this.sendKeyed(userId, "app_list", {
        type: "app_list",
        apps: lists.get(userId) ?? [],
      });
    }
  }

  private connected(userId: string): boolean {
    return this.ctx.hub.memberSinksOfUser(userId).length > 0;
  }

  private send(userId: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.memberSinksOfUser(userId)) sink.send(frame);
  }

  /** Sends a whole-value frame to each of the user's sockets that does not
   *  already hold it. */
  private sendKeyed(userId: string, key: string, frame: WsServerMsg): void {
    for (const sink of this.ctx.hub.memberSinksOfUser(userId))
      sendChanged(sink, key, frame);
  }
}
