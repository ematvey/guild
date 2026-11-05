// Integration access: an Integration's audience (who may attach it to an
// Agent, and up to which tool class), each Agent's Integration list, and the
// warnings that show where an Agent's audience is wider than an Integration
// it lists. An Agent with chosen tools has an explicit list, and the
// audience is checked only when someone adds or raises an entry. An Agent
// with `all` tools derives its list from the audiences of the people who can
// use it.

import { classRank, type ToolClass } from "./tool-class.js";

export type IntegrationAudienceKind = "org" | "team" | "admins";
/** A grant's ceiling: `admin`-class tools are admin-only whatever a grant says. */
export type GrantCeiling = "read" | "write";

export const AUDIENCES: readonly IntegrationAudienceKind[] = ["org", "team", "admins"];

export function isAudience(value: unknown): value is IntegrationAudienceKind {
  return value === "org" || value === "team" || value === "admins";
}

export function isGrantCeiling(value: unknown): value is GrantCeiling {
  return value === "read" || value === "write";
}

/** One installed Integration's audience. */
export interface IntegrationAudience {
  id: string;
  slug: string;
  enabled: boolean;
  audience: IntegrationAudienceKind;
  org_ceiling: GrantCeiling;
  grants: { team_id: string; ceiling: GrantCeiling }[];
}

/** One entry of an Agent's Integration list. */
export interface AgentIntegrationEntry {
  slug: string;
  ceiling: ToolClass;
}

/** One place an Agent gives someone more of an Integration than its
 *  audience grants them. */
export interface IntegrationWarning {
  integration: string;
  /** Who gains the reach: every member, a team, or one member. */
  subject: "org" | "team" | "member";
  subject_id: string | null;
  subject_label: string;
  /** The class the Agent gives that subject. */
  ceiling: ToolClass;
  /** The class the audience grants that subject; null: none. */
  granted: ToolClass | null;
}

/** A member as the audience rules read them. */
export interface AccessMember {
  id: string;
  label: string;
  role: string;
  team_ids: ReadonlySet<string>;
}

function maxClass(a: ToolClass | null, b: ToolClass | null): ToolClass | null {
  if (a === null) return b;
  if (b === null) return a;
  return classRank(a) >= classRank(b) ? a : b;
}

function minClass(a: ToolClass, b: ToolClass): ToolClass {
  return classRank(a) <= classRank(b) ? a : b;
}

/** The ceiling the audience grants one member: an admin always gets
 *  `admin`; otherwise the org ceiling, the highest grant of their teams, or
 *  nothing. */
export function memberCeiling(
  access: IntegrationAudience,
  member: { role: string; team_ids: ReadonlySet<string> },
): ToolClass | null {
  if (member.role === "admin") return "admin";
  if (access.audience === "org") return access.org_ceiling;
  if (access.audience === "admins") return null;
  let best: ToolClass | null = null;
  for (const grant of access.grants) {
    if (member.team_ids.has(grant.team_id)) best = maxClass(best, grant.ceiling);
  }
  return best;
}

/** The ceiling the audience grants every member of one team. */
function teamCeiling(access: IntegrationAudience, teamId: string): ToolClass | null {
  if (access.audience === "org") return access.org_ceiling;
  if (access.audience === "admins") return null;
  return access.grants.find((grant) => grant.team_id === teamId)?.ceiling ?? null;
}

/** Whether a tool of `cls` falls within `ceiling`. */
export function classWithin(cls: string, ceiling: ToolClass | null): boolean {
  return ceiling !== null && classRank(cls) <= classRank(ceiling);
}

/** The Agent facts the warnings read. */
export interface WarnedAgent {
  owner_user_id: string;
  visibility: string;
  is_personal: boolean;
  team_ids?: string[];
  integrations: AgentIntegrationEntry[];
}

/** The org facts the warnings read, loaded once per org. */
export interface AccessContext {
  audiences: Map<string, IntegrationAudience>;
  members: Map<string, AccessMember>;
  teams: Map<string, string>;
  /** Members granted one Agent by name, keyed by agent id. */
  userGrants: Map<string, string[]>;
}

/** Someone who can use an Agent, as the audience rules read them. */
interface AgentSubject {
  subject: IntegrationWarning["subject"];
  id: string | null;
  label: string;
  /** Whether the subject is an admin: a non-admin never reaches
   *  `admin`-class tools. */
  admin: boolean;
  /** The ceiling an Integration's audience grants the subject. */
  granted(access: IntegrationAudience): ToolClass | null;
}

/** The people who can use an Agent: its owner, members granted it by
 *  name, its teams (`team` visibility) or every member (`org`). A personal
 *  Agent has its owner only. */
function agentSubjects(agent: Omit<WarnedAgent, "integrations"> & { id: string }, ctx: AccessContext): AgentSubject[] {
  const out: AgentSubject[] = [];
  const asMember = (member: AccessMember): AgentSubject => ({
    subject: "member",
    id: member.id,
    label: member.label,
    admin: member.role === "admin",
    granted: (access) => memberCeiling(access, member),
  });
  const owner = ctx.members.get(agent.owner_user_id);
  if (owner !== undefined) out.push(asMember(owner));
  if (agent.is_personal) return out;
  if (agent.visibility === "org") {
    out.push({
      subject: "org",
      id: null,
      label: "Every member",
      admin: false,
      granted: (access) => (access.audience === "org" ? access.org_ceiling : null),
    });
  } else if (agent.visibility === "team") {
    for (const teamId of agent.team_ids ?? []) {
      out.push({
        subject: "team",
        id: teamId,
        label: ctx.teams.get(teamId) ?? "A team",
        admin: false,
        granted: (access) => teamCeiling(access, teamId),
      });
    }
  }
  for (const userId of ctx.userGrants.get(agent.id) ?? []) {
    if (userId === agent.owner_user_id) continue;
    const member = ctx.members.get(userId);
    if (member !== undefined) out.push(asMember(member));
  }
  return out;
}

/** Where the Agent gives a subject more of an Integration than the
 *  Integration's audience grants that subject. A non-admin subject never
 *  reaches `admin`-class tools, so the Agent's ceiling is capped at `write`
 *  for them. An Integration that is no longer installed warns nothing: its
 *  entry is gone with it. */
export function agentWarnings(agent: WarnedAgent & { id: string }, ctx: AccessContext): IntegrationWarning[] {
  const out: IntegrationWarning[] = [];
  const subjects = agentSubjects(agent, ctx);
  for (const entry of agent.integrations) {
    const access = ctx.audiences.get(entry.slug);
    if (access === undefined) continue;
    for (const subject of subjects) {
      const gives = subject.admin ? entry.ceiling : minClass(entry.ceiling, "write");
      const granted = subject.granted(access);
      if (granted !== null && classRank(gives) <= classRank(granted)) continue;
      out.push({
        integration: entry.slug,
        subject: subject.subject,
        subject_id: subject.id,
        subject_label: subject.label,
        ceiling: gives,
        granted,
      });
    }
  }
  return out;
}

/** The Integration list of an Agent whose tools are `all`: every enabled
 *  Integration that everyone who can use the Agent may reach, at the
 *  lowest ceiling the audience grants any of them. A personal Agent follows
 *  its owner's reach; a shared one never gives anyone more than their own,
 *  so the list warns nothing. It is derived on every read, so an
 *  Integration an admin adds or opens up reaches the Agent at once. */
export function allModeIntegrations(
  agent: Omit<WarnedAgent, "integrations"> & { id: string },
  ctx: AccessContext,
): AgentIntegrationEntry[] {
  const subjects = agentSubjects(agent, ctx);
  if (subjects.length === 0) return [];
  const out: AgentIntegrationEntry[] = [];
  for (const access of ctx.audiences.values()) {
    if (!access.enabled) continue;
    let ceiling: ToolClass | null = "admin";
    for (const subject of subjects) {
      const granted = subject.granted(access);
      if (granted === null) {
        ceiling = null;
        break;
      }
      ceiling = minClass(ceiling, granted);
    }
    if (ceiling !== null) out.push({ slug: access.slug, ceiling });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The Integrations an Agent reaches: its own list, or for `all` tools the
 *  derived one. */
export function agentIntegrations(
  agent: WarnedAgent & { id: string; tools_mode: string },
  ctx: AccessContext,
): AgentIntegrationEntry[] {
  return agent.tools_mode === "all" ? allModeIntegrations(agent, ctx) : agent.integrations;
}

/** The Integrations one member may attach, with the class they may grant. */
export interface AttachableIntegration {
  slug: string;
  title: string;
  summary: string;
  enabled: boolean;
  ceiling: ToolClass;
}

/** An installed Integration's display facts. */
export interface IntegrationDisplay {
  title: string;
  summary: string;
}
