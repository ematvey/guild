// The guild introspection tools: the org's members, usage, threads and
// agents, read by the admin's personal assistant. They exist only for that
// caller (turn-tools checks the owner's role and the agent's personal flag),
// and every read is the same read an admin's HTTP surfaces make: the org
// scope of 002-access. A script calls them through code mode under the
// `guild` namespace.

import { Type } from "typebox";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { IdentityStore } from "../platform/store/identity.js";
import type { TeamStore } from "../platform/store/teams.js";
import type { UserRow } from "../platform/store/identity.js";
import { startOfDayUtc, startOfMonthUtc } from "../platform/usage.js";
import {
  UsageReports,
  usageGroupNames,
  type UsageBucket,
  type UsageFilters,
  type UsageGroup,
} from "../platform/store/usage.js";
import type { AgentStore } from "./store.js";
import { readThreadTranscript } from "./thread-read.js";
import { structured } from "../harness/tool-schema.js";

/** The largest page an introspection read returns. */
const MAX_LIST = 200;
const MAX_THREADS = 500;
const DEFAULT_THREADS = 50;

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

function fail(error: unknown): ToolExecutionResult {
  return textErr(error instanceof Error ? error.message : String(error));
}

/** RFC 3339 or YYYY-MM-DD, the usage routes' date contract. */
function parseDate(value: string, field: string): Date {
  const rfc = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (rfc) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00Z`);
  throw new Error(`${field} must be RFC 3339 or YYYY-MM-DD`);
}

export interface GuildToolDeps {
  readonly pool: PlatformPool;
  readonly identity: Pick<IdentityStore, "listUsers">;
  readonly teams: Pick<TeamStore, "listTeams" | "listMembers">;
  readonly agents: Pick<AgentStore, "listForOrg">;
  readonly chats: Pick<ChatStore, "listOrgChats" | "orgChatCounts" | "getChat">;
  /** The ClickHouse usage reports; absent when the process has no usage
   *  store, and then the usage reads answer empty. */
  readonly usage?: UsageReports;
  /** The admin whose assistant is asking: the org and the thread read gate. */
  readonly admin: UserRow;
}

/** One member's teams, keyed by user id. */
async function teamsByUser(deps: GuildToolDeps): Promise<Map<string, string[]>> {
  const teams = await deps.teams.listTeams(deps.admin.org_id);
  const byUser = new Map<string, string[]>();
  for (const team of teams) {
    const members = await deps.teams.listMembers(deps.admin.org_id, team.id);
    for (const member of members) {
      const names = byUser.get(member.id) ?? [];
      names.push(team.name);
      byUser.set(member.id, names);
    }
  }
  return byUser;
}

/** Group ids become names for users and teams; a model group's id is the
 *  model name already. */
async function groupNames(deps: GuildToolDeps, group: UsageGroup): Promise<Map<string, string>> {
  if (group === "model") return new Map();
  return usageGroupNames(deps.pool, deps.admin.org_id, group);
}

/** Whether an agent's turns carry the guild tools: the admin's personal
 *  assistant only. */
export function guildToolsAllowed(agent: { is_personal: boolean }, ownerRole: string): boolean {
  return agent.is_personal && ownerRole === "admin";
}

const overviewOutput = Type.Object({
  window_days: Type.Number(),
  members: Type.Object({ total: Type.Number(), admins: Type.Number(), members: Type.Number() }),
  agents: Type.Object({
    total: Type.Number(),
    personal: Type.Number(),
    shared: Type.Number(),
    archived: Type.Number(),
  }),
  threads: Type.Object({
    total: Type.Number(),
    active: Type.Number(),
    active_in_window: Type.Number(),
    archived: Type.Number(),
    deleted: Type.Number(),
  }),
  usage: Type.Object({
    today_cost_usd: Type.Number(),
    today_tokens: Type.Number(),
    month_cost_usd: Type.Number(),
    month_tokens: Type.Number(),
  }),
});

const memberOutput = Type.Object({
  user_id: Type.String(),
  email: Type.String(),
  role: Type.String(),
  identity_type: Type.String(),
  created_at: Type.String(),
  teams: Type.Array(Type.String()),
});

const membersOutput = Type.Object({ members: Type.Array(memberOutput) });

const usageOutput = Type.Object({
  group_by: Type.Optional(Type.String()),
  bucket: Type.Optional(Type.String()),
  since: Type.Optional(Type.String()),
  cost_usd: Type.Optional(Type.Number()),
  tokens: Type.Optional(Type.Number()),
  rows: Type.Optional(
    Type.Array(
      Type.Object({
        bucket: Type.Optional(Type.String()),
        group: Type.String(),
        tokens_in: Type.Number(),
        tokens_out: Type.Number(),
        cost_usd: Type.Number(),
        requests: Type.Number(),
      }),
    ),
  ),
});

const orgThreadOutput = Type.Object({
  thread_id: Type.String(),
  user_id: Type.String(),
  email: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  type: Type.String(),
  agent_id: Type.Union([Type.String(), Type.Null()]),
  agent_name: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  last_activity_at: Type.String(),
  archived: Type.Boolean(),
  deleted: Type.Boolean(),
});

const orgThreadsOutput = Type.Object({ threads: Type.Array(orgThreadOutput) });

const transcriptOutput = Type.Object({
  thread_id: Type.String(),
  thread_title: Type.String(),
  events: Type.Array(
    Type.Object({
      seq: Type.Number(),
      type: Type.String(),
      ts: Type.String(),
      text: Type.String(),
    }),
  ),
  truncated: Type.Boolean(),
});

const agentRowOutput = Type.Object({
  agent_id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  owner_user_id: Type.String(),
  owner_email: Type.Union([Type.String(), Type.Null()]),
  model: Type.String(),
  model_alias: Type.Union([Type.String(), Type.Null()]),
  visibility: Type.String(),
  personal: Type.Boolean(),
  status: Type.String(),
  tools_mode: Type.String(),
  created_at: Type.String(),
});

const orgAgentsOutput = Type.Object({ agents: Type.Array(agentRowOutput) });

/** The guild tools, in prompt order. */
export function createGuildTools(deps: GuildToolDeps): ToolRegistration[] {
  const orgId = deps.admin.org_id;
  return [
    defineTool({
      name: "guild_overview",
      description:
        "The org at a glance: member and agent counts, thread counts (all and active in the window), and the " +
        "org's spend and tokens today and this month. Start here for a usage or adoption question.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Activity window in days for the thread counts; default 7" })),
      }),
      structuredOutputSchema: overviewOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 16 * 1024 },
      execute: async (args) => {
        try {
          const days = Math.min(Math.max(args.days ?? 7, 1), 365);
          const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          const users = await deps.identity.listUsers(orgId);
          const agents = await deps.agents.listForOrg(orgId, { includeArchived: true });
          const threads = await deps.chats.orgChatCounts(orgId, since);
          const usage = deps.usage;
          const today = usage === undefined ? { cost: 0, tokens: 0 } : await usage.spendSince({ orgId, userId: null }, startOfDayUtc());
          const month = usage === undefined ? { cost: 0, tokens: 0 } : await usage.spendSince({ orgId, userId: null }, startOfMonthUtc());
          return {
            structuredOutput: structured({
              window_days: days,
              members: {
                total: users.length,
                admins: users.filter((user) => user.role === "admin").length,
                members: users.filter((user) => user.role !== "admin").length,
              },
              agents: {
                total: agents.length,
                personal: agents.filter((agent) => agent.is_personal).length,
                shared: agents.filter((agent) => !agent.is_personal).length,
                archived: agents.filter((agent) => agent.status === "archived").length,
              },
              threads: { ...threads, active_in_window: threads.active },
              usage: {
                today_cost_usd: today.cost,
                today_tokens: today.tokens,
                month_cost_usd: month.cost,
                month_tokens: month.tokens,
              },
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),

    defineTool({
      name: "guild_members",
      description:
        "The org's members: id, email, role, identity type, join date and team names. Filter by a substring of " +
        "the email.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Substring of the email" })),
        limit: Type.Optional(Type.Number({ description: `Max rows, 1–${MAX_LIST}` })),
      }),
      structuredOutputSchema: membersOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 64 * 1024 },
      execute: async (args) => {
        try {
          const limit = Math.min(Math.max(args.limit ?? MAX_LIST, 1), MAX_LIST);
          const query = (args.query ?? "").trim().toLowerCase();
          const teams = await teamsByUser(deps);
          const users = (await deps.identity.listUsers(orgId))
            .filter((user) => query === "" || user.email.toLowerCase().includes(query))
            .slice(0, limit);
          return {
            structuredOutput: structured({
              members: users.map((user) => ({
                user_id: user.id,
                email: user.email,
                role: user.role,
                identity_type: user.identity_type,
                created_at: user.created_at,
                teams: teams.get(user.id) ?? [],
              })),
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),

    defineTool({
      name: "guild_usage",
      description:
        "The org's model usage from the usage events: a breakdown per member, team or model, a bucketed series, " +
        "or the totals since a date. Group ids come back as emails and team names.",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union([Type.Literal("breakdown"), Type.Literal("series"), Type.Literal("totals")], {
            description: "breakdown (default), series or totals",
          }),
        ),
        group_by: Type.Optional(
          Type.Union([Type.Literal("user"), Type.Literal("team"), Type.Literal("model")], {
            description: "Breakdown and series grouping; default user",
          }),
        ),
        bucket: Type.Optional(
          Type.Union([Type.Literal("day"), Type.Literal("hour")], { description: "Series bucket; default day" }),
        ),
        from: Type.Optional(Type.String({ description: "Window start, RFC 3339 or YYYY-MM-DD" })),
        to: Type.Optional(Type.String({ description: "Window end, RFC 3339 or YYYY-MM-DD" })),
        team_id: Type.Optional(Type.String({ description: "Only this team's usage" })),
      }),
      structuredOutputSchema: usageOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 64 * 1024 },
      execute: async (args) => {
        try {
          const usage = deps.usage;
          if (usage === undefined) return textErr("usage reports are not available in this process");
          const group: UsageGroup = args.group_by ?? "user";
          const filters: UsageFilters = {
            ...(args.from === undefined ? {} : { from: parseDate(args.from, "from") }),
            ...(args.to === undefined ? {} : { to: parseDate(args.to, "to") }),
            ...(args.team_id === undefined ? {} : { teamId: args.team_id }),
          };
          const scope = { orgId, userId: null };
          const mode = args.mode ?? "breakdown";
          if (mode === "totals") {
            const since = filters.from ?? startOfMonthUtc();
            const totals = await usage.spendSince(scope, since);
            return {
              structuredOutput: structured({
                since: since.toISOString(),
                cost_usd: totals.cost,
                tokens: totals.tokens,
              }),
            };
          }
          if (mode === "series") {
            const bucket: UsageBucket = args.bucket ?? "day";
            const rows = await usage.series(scope, bucket, group, filters);
            const names = await groupNames(deps, group);
            return {
              structuredOutput: structured({
                bucket,
                group_by: group,
                rows: rows.map((row) => ({
                  bucket: `${String(row["bucket"]).replace(" ", "T")}+00:00`,
                  group: names.get(String(row["group"])) ?? String(row["group"] ?? ""),
                  tokens_in: Number(row["tokens_in"] ?? 0),
                  tokens_out: Number(row["tokens_out"] ?? 0),
                  cost_usd: Number(row["cost_usd"] ?? 0),
                  requests: Number(row["requests"] ?? 0),
                })),
              }),
            };
          }
          const rows = await usage.breakdown(scope, group, filters);
          const names = await groupNames(deps, group);
          return {
            structuredOutput: structured({
              group_by: group,
              rows: rows.map((row) => ({
                group: names.get(String(row["group"])) ?? String(row["group"] ?? ""),
                tokens_in: Number(row["tokens_in"] ?? 0),
                tokens_out: Number(row["tokens_out"] ?? 0),
                cost_usd: Number(row["cost_usd"] ?? 0),
                requests: Number(row["requests"] ?? 0),
              })),
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),

    defineTool({
      name: "guild_threads",
      description:
        "Threads across the whole org, newest activity first: id, owner email, title, thread type, agent, " +
        "creation and last activity. Filter by owner email, agent, activity window or archive state. Use " +
        "guild_thread_read with a thread id to read one.",
      parameters: Type.Object({
        email: Type.Optional(Type.String({ description: "Substring of the owner's email" })),
        user_id: Type.Optional(Type.String({ description: "One owner's user id" })),
        agent_id: Type.Optional(Type.String({ description: "Only threads of this agent" })),
        from: Type.Optional(Type.String({ description: "Last activity at or after, RFC 3339 or YYYY-MM-DD" })),
        to: Type.Optional(Type.String({ description: "Last activity before, RFC 3339 or YYYY-MM-DD" })),
        archived: Type.Optional(Type.Boolean({ description: "true = archived only; omit for both" })),
        deleted: Type.Optional(Type.Boolean({ description: "true = deleted only; omit or false hides them" })),
        limit: Type.Optional(Type.Number({ description: `Max rows, 1–${MAX_THREADS}; default ${DEFAULT_THREADS}` })),
      }),
      structuredOutputSchema: orgThreadsOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 64 * 1024 },
      execute: async (args) => {
        try {
          const rows = await deps.chats.listOrgChats(orgId, {
            ...(args.email === undefined ? {} : { email: args.email }),
            ...(args.user_id === undefined ? {} : { userId: args.user_id }),
            ...(args.agent_id === undefined ? {} : { agentId: args.agent_id }),
            ...(args.from === undefined ? {} : { from: parseDate(args.from, "from") }),
            ...(args.to === undefined ? {} : { to: parseDate(args.to, "to") }),
            ...(args.archived === undefined ? {} : { archived: args.archived }),
            deleted: args.deleted === true,
            limit: args.limit ?? DEFAULT_THREADS,
          });
          return {
            structuredOutput: structured({
              threads: rows.map((row) => ({
                thread_id: row.id,
                user_id: row.user_id,
                email: row.email,
                title: row.title,
                type: row.type,
                agent_id: row.agent_id,
                agent_name: row.agent_name,
                created_at: row.created_at,
                last_activity_at: row.last_activity_at,
                archived: row.archived,
                deleted: row.deleted,
              })),
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),

    defineTool({
      name: "guild_thread_read",
      description:
        "Read one thread's transcript, whoever owns it. Returns at most 200 events and 20k characters; pass " +
        "from_seq to continue after the last seq you read.",
      parameters: Type.Object({
        thread_id: Type.String({ description: "The thread (chat) id from guild_threads" }),
        from_seq: Type.Optional(Type.Number({ description: "First seq to return" })),
        to_seq: Type.Optional(Type.Number({ description: "Last seq to return" })),
      }),
      structuredOutputSchema: transcriptOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 64 * 1024 },
      execute: async (args) => {
        try {
          const chat = await deps.chats.getChat(orgId, args.thread_id, deps.admin);
          const read = await readThreadTranscript(deps.pool, {
            threadId: chat.id,
            chatId: chat.id,
            title: chat.title ?? "",
            ...(args.from_seq === undefined ? {} : { fromSeq: args.from_seq }),
            ...(args.to_seq === undefined ? {} : { toSeq: args.to_seq }),
          });
          return { structuredOutput: structured(read) };
        } catch (error) {
          return fail(error);
        }
      },
    }),

    defineTool({
      name: "guild_agents",
      description:
        "Every agent of the org: id, name, owner email, model, visibility, personal flag, status and tool mode. " +
        "Filter by status or owner email.",
      parameters: Type.Object({
        email: Type.Optional(Type.String({ description: "Substring of the owner's email" })),
        status: Type.Optional(
          Type.Union([Type.Literal("active"), Type.Literal("archived"), Type.Literal("deleting")], {
            description: "One status; omit for every status",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: `Max rows, 1–${MAX_LIST}` })),
      }),
      structuredOutputSchema: orgAgentsOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 64 * 1024 },
      execute: async (args) => {
        try {
          const limit = Math.min(Math.max(args.limit ?? MAX_LIST, 1), MAX_LIST);
          const query = (args.email ?? "").trim().toLowerCase();
          const agents = await deps.agents.listForOrg(orgId, {
            includeArchived: true,
            ...(args.status === undefined ? {} : { status: args.status }),
          });
          return {
            structuredOutput: structured({
              agents: agents
                .filter((agent) => query === "" || (agent.owner_email ?? "").toLowerCase().includes(query))
                .slice(0, limit)
                .map((agent) => ({
                  agent_id: agent.id,
                  name: agent.name,
                  description: agent.description,
                  owner_user_id: agent.owner_user_id,
                  owner_email: agent.owner_email ?? null,
                  model: agent.model,
                  model_alias: agent.model_alias ?? null,
                  visibility: agent.visibility,
                  personal: agent.is_personal,
                  status: agent.status,
                  tools_mode: agent.tools_mode,
                  created_at: agent.created_at,
                })),
            }),
          };
        } catch (error) {
          return fail(error);
        }
      },
    }),
  ];
}
