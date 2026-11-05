// Integration access storage: audiences and their team grants, each Agent's
// Integration list, the org facts the warnings read, and the reach of the
// Agent a chat belongs to. The rules live in domain/integration-access.ts.

import { ApiError } from "../errors.js";
import { withTransaction, type PlatformPool } from "../db.js";
import { classRank, type ToolClass } from "../domain/tool-class.js";
import {
  agentIntegrations,
  classWithin,
  memberCeiling,
  type AccessContext,
  type AccessMember,
  type AgentIntegrationEntry,
  type AttachableIntegration,
  type GrantCeiling,
  type IntegrationAudience,
  type IntegrationAudienceKind,
  type IntegrationDisplay,
  type WarnedAgent,
} from "../domain/integration-access.js";

type Db = { query: PlatformPool["query"] };

/** The agent columns the access rules read (`a` is the agents row). */
const AGENT_ACCESS_COLUMNS = `a.id, a.org_id, a.owner_user_id, a.visibility, a.is_personal, a.tools_mode, a.tools,
  COALESCE((SELECT array_agg(tg.team_id::text) FROM agent_team_grants tg WHERE tg.agent_id = a.id), '{}') AS team_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', i.name, 'ceiling', ai.ceiling) ORDER BY i.name)
              FROM agent_integrations ai JOIN integrations i ON i.id = ai.integration_id
             WHERE ai.agent_id = a.id), '[]'::jsonb) AS integrations`;

function accessAgent(row: Record<string, unknown>): WarnedAgent & { id: string; org_id: string; tools_mode: string } {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    owner_user_id: row.owner_user_id as string,
    visibility: row.visibility as string,
    is_personal: row.is_personal === true,
    tools_mode: row.tools_mode as string,
    team_ids: row.team_ids as string[],
    integrations: row.integrations as AgentIntegrationEntry[],
  };
}

export class IntegrationAccessStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Every installed Integration's audience in the org, keyed by slug. */
  async audiences(orgId: string, db: Db = this.pool): Promise<Map<string, IntegrationAudience>> {
    const res = await db.query(
      `SELECT i.id, i.name, i.enabled, i.audience, i.org_ceiling,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('team_id', g.team_id, 'ceiling', g.ceiling)
                                         ORDER BY g.team_id)
                          FROM integration_grants g WHERE g.integration_id = i.id), '[]'::jsonb) AS grants
         FROM integrations i WHERE i.org_id = $1 ORDER BY i.name`,
      [orgId],
    );
    const out = new Map<string, IntegrationAudience>();
    for (const row of res.rows as Record<string, unknown>[]) {
      out.set(row.name as string, {
        id: row.id as string,
        slug: row.name as string,
        enabled: row.enabled === true,
        audience: row.audience as IntegrationAudienceKind,
        org_ceiling: row.org_ceiling as GrantCeiling,
        grants: row.grants as { team_id: string; ceiling: GrantCeiling }[],
      });
    }
    return out;
  }

  /** One Integration's audience by row id; 404 outside the org. */
  async audienceById(orgId: string, id: string): Promise<IntegrationAudience> {
    for (const access of (await this.audiences(orgId)).values()) {
      if (access.id === id) return access;
    }
    throw ApiError.notFound("unknown integration");
  }

  /** The org's members with their teams. */
  async members(orgId: string): Promise<Map<string, AccessMember>> {
    const res = await this.pool.query(
      `SELECT u.id, COALESCE(u.display_name, u.email) AS label, u.role,
              COALESCE(array_agg(tm.team_id::text) FILTER (WHERE tm.team_id IS NOT NULL), '{}') AS team_ids
         FROM users u LEFT JOIN team_members tm ON tm.user_id = u.id
        WHERE u.org_id = $1 GROUP BY u.id`,
      [orgId],
    );
    const out = new Map<string, AccessMember>();
    for (const row of res.rows as Record<string, unknown>[]) {
      out.set(row.id as string, {
        id: row.id as string,
        label: (row.label as string | null) ?? "",
        role: row.role as string,
        team_ids: new Set(row.team_ids as string[]),
      });
    }
    return out;
  }

  /** One member with their teams, as the attach check reads them. */
  async member(orgId: string, userId: string): Promise<AccessMember | null> {
    return (await this.members(orgId)).get(userId) ?? null;
  }

  /** The org facts every Agent's warnings read, in four queries. */
  async context(orgId: string): Promise<AccessContext> {
    const [audiences, members, teams, grants] = await Promise.all([
      this.audiences(orgId),
      this.members(orgId),
      this.pool.query("SELECT id, name FROM teams WHERE org_id = $1", [orgId]),
      this.pool.query(
        `SELECT g.agent_id, g.user_id FROM agent_grants g JOIN agents a ON a.id = g.agent_id
          WHERE a.org_id = $1 AND g.role = 'user'`,
        [orgId],
      ),
    ]);
    const userGrants = new Map<string, string[]>();
    for (const row of grants.rows as { agent_id: string; user_id: string }[]) {
      const list = userGrants.get(row.agent_id) ?? [];
      list.push(row.user_id);
      userGrants.set(row.agent_id, list);
    }
    return {
      audiences,
      members,
      teams: new Map((teams.rows as { id: string; name: string }[]).map((t) => [t.id, t.name])),
      userGrants,
    };
  }

  /** Replaces an Integration's audience and its team grants in one
   *  transaction. Every team must belong to the org. */
  async setAudience(
    orgId: string,
    integrationId: string,
    audience: IntegrationAudienceKind,
    orgCeiling: GrantCeiling,
    grants: { team_id: string; ceiling: GrantCeiling }[],
  ): Promise<void> {
    const unique = new Map(grants.map((grant) => [grant.team_id, grant.ceiling]));
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        "UPDATE integrations SET audience = $3, org_ceiling = $4, updated_at = now() WHERE org_id = $1 AND id = $2",
        [orgId, integrationId, audience, orgCeiling],
      );
      if (updated.rowCount === 0) throw ApiError.notFound("unknown integration");
      if (unique.size > 0) {
        const valid = await client.query("SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])", [
          orgId,
          [...unique.keys()],
        ]);
        if (valid.rowCount !== unique.size) throw ApiError.badRequest("unknown team");
      }
      await client.query("DELETE FROM integration_grants WHERE integration_id = $1", [integrationId]);
      for (const [teamId, ceiling] of unique) {
        await client.query(
          "INSERT INTO integration_grants (integration_id, org_id, team_id, ceiling) VALUES ($1, $2, $3, $4)",
          [integrationId, orgId, teamId, ceiling],
        );
      }
    });
  }

  /** Replaces an Agent's Integration list. An entry that is new, or whose
   *  ceiling rises, needs the caller's own audience ceiling at least as high;
   *  an unchanged or lowered entry, and a removal, need nothing beyond
   *  managing the Agent (the route checks that). */
  async setAgentIntegrations(
    orgId: string,
    agentId: string,
    entries: AgentIntegrationEntry[],
    caller: { id: string; role: string; team_ids: ReadonlySet<string> },
  ): Promise<void> {
    const wanted = new Map(entries.map((entry) => [entry.slug, entry.ceiling]));
    await withTransaction(this.pool, async (client) => {
      const audiences = await this.audiences(orgId, client);
      const current = await client.query(
        `SELECT i.name, ai.ceiling FROM agent_integrations ai JOIN integrations i ON i.id = ai.integration_id
          WHERE ai.agent_id = $1`,
        [agentId],
      );
      const before = new Map((current.rows as { name: string; ceiling: ToolClass }[]).map((r) => [r.name, r.ceiling]));
      for (const [slug, ceiling] of wanted) {
        const access = audiences.get(slug);
        if (access === undefined) throw ApiError.badRequest(`unknown integration ${slug}`);
        const prior = before.get(slug);
        if (prior !== undefined && classRank(ceiling) <= classRank(prior)) continue;
        const own = memberCeiling(access, caller);
        if (!classWithin(ceiling, own)) {
          throw ApiError.forbidden(
            own === null
              ? `${slug} is not available to you, so you cannot add it to an agent`
              : `you can give ${slug} at most ${own} access`,
          );
        }
      }
      for (const slug of before.keys()) {
        if (!wanted.has(slug)) {
          await client.query("DELETE FROM agent_integrations WHERE agent_id = $1 AND integration_id = $2", [
            agentId,
            audiences.get(slug)?.id,
          ]);
        }
      }
      for (const [slug, ceiling] of wanted) {
        if (before.get(slug) === ceiling) continue;
        await client.query(
          `INSERT INTO agent_integrations (agent_id, integration_id, ceiling, added_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (agent_id, integration_id) DO UPDATE SET ceiling = EXCLUDED.ceiling,
             added_by = EXCLUDED.added_by, added_at = now()`,
          [agentId, audiences.get(slug)!.id, ceiling, caller.id],
        );
      }
    });
  }

  /** The Agents that reach one Integration (by their list, or derived for
   *  `all` tools), with what their warnings read. */
  async agentsUsing(
    orgId: string,
    integrationId: string,
    ctx: AccessContext,
  ): Promise<(WarnedAgent & { id: string; name: string; status: string; owner_label: string })[]> {
    const res = await this.pool.query(
      `SELECT ${AGENT_ACCESS_COLUMNS}, a.name, a.status,
              COALESCE((SELECT u.display_name FROM users u WHERE u.id = a.owner_user_id),
                       (SELECT u.email FROM users u WHERE u.id = a.owner_user_id), '') AS owner_label
         FROM agents a
        WHERE a.org_id = $1 AND a.status IN ('active', 'archived')
          AND (a.tools_mode = 'all'
               OR EXISTS (SELECT 1 FROM agent_integrations ai WHERE ai.agent_id = a.id AND ai.integration_id = $2))
        ORDER BY a.name`,
      [orgId, integrationId],
    );
    const slug = [...ctx.audiences.values()].find((access) => access.id === integrationId)?.slug;
    const out: (WarnedAgent & { id: string; name: string; status: string; owner_label: string })[] = [];
    for (const row of res.rows as Record<string, unknown>[]) {
      const agent = accessAgent(row);
      const integrations = agentIntegrations(agent, ctx).filter((entry) => entry.slug === slug);
      if (integrations.length === 0) continue;
      out.push({
        ...agent,
        integrations,
        name: row.name as string,
        status: row.status as string,
        owner_label: row.owner_label as string,
      });
    }
    return out;
  }

  /** The Trait allowlist and Integration entries of the Agent a chat
   *  belongs to (derived for `all` tools); null for a chat with no Agent. */
  async chatAgentReach(
    chatId: string,
  ): Promise<{ tools_mode: string; tools: string[]; entries: AgentIntegrationEntry[] } | null> {
    const res = await this.pool.query(
      `SELECT ${AGENT_ACCESS_COLUMNS}
         FROM agent_threads t JOIN agents a ON a.id = t.agent_id
        WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const agent = accessAgent(row);
    const entries = agent.tools_mode === "all" ? agentIntegrations(agent, await this.context(agent.org_id)) : agent.integrations;
    return { tools_mode: agent.tools_mode, tools: (row.tools as string[] | null) ?? [], entries };
  }

  /** The Integrations each of `userIds` may attach. */
  async attachable(
    orgId: string,
    userIds: readonly string[],
    display: (slug: string) => IntegrationDisplay | undefined,
  ): Promise<Map<string, AttachableIntegration[]>> {
    const [audiences, members] = await Promise.all([this.audiences(orgId), this.members(orgId)]);
    const out = new Map<string, AttachableIntegration[]>();
    for (const userId of userIds) {
      const member = members.get(userId);
      if (member === undefined) continue;
      const list: AttachableIntegration[] = [];
      for (const access of audiences.values()) {
        const ceiling = memberCeiling(access, member);
        if (ceiling === null) continue;
        const shown = display(access.slug);
        list.push({
          slug: access.slug,
          title: shown?.title ?? access.slug,
          summary: shown?.summary ?? "",
          enabled: access.enabled,
          ceiling,
        });
      }
      out.set(userId, list);
    }
    return out;
  }
}
