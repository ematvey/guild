// Integration tools a member calls directly, outside a Turn: the script API
// and App data functions. No Agent stands between the member and the
// Integration, so each Integration's audience decides the member's ceiling;
// the Org's curation, the admin-only rule for `admin`-class tools and the
// `integration.tool_called` audit apply as in a Turn.

import { ApiError } from "../platform/errors.js";
import type { EventStore } from "../platform/store/events.js";
import type { IntegrationAccessStore } from "../platform/store/integration-access.js";
import { memberCeiling } from "../platform/domain/integration-access.js";
import type { ToolClass } from "../platform/domain/tool-class.js";
import { auditError, callPlugin } from "./execute.js";
import { resolveIntegrations, unnamespacedTool, type IntegrationGateway, type IntegrationTurn } from "./plugins.js";
import { scopeCeiling, toolCurate, toolOffered, type IntegrationScope } from "./policy.js";
import type { JsonObject } from "./shared.js";

/** The caller of the script API: an org member (session) or an org API key.
 *  API keys act with their creating user's role (usage attributes the same
 *  way); their acting identity is null unless declared. */
export interface IntegrationCaller {
  org: string;
  userId: string;
  email: string | null;
  role: string;
}

export async function turns(gateway: IntegrationGateway, orgId: string): Promise<IntegrationTurn[]> {
  try {
    return await resolveIntegrations(gateway, orgId);
  } catch {
    // The resolved plugins of the caller's org — a broken plugin contributes
    // nothing (spec §8).
    return [];
  }
}

/** A script caller's reach: no Agent stands between the caller and the
 *  Integration, so each Integration's audience decides the ceiling the
 *  caller gets. Trait tools are open to every caller. */
export async function callerScope(
  access: IntegrationAccessStore,
  caller: IntegrationCaller,
): Promise<IntegrationScope> {
  const [audiences, member] = await Promise.all([
    access.audiences(caller.org),
    access.member(caller.org, caller.userId),
  ]);
  const self = { role: caller.role, team_ids: member?.team_ids ?? new Set<string>() };
  const integrations = new Map<string, ToolClass>();
  for (const audience of audiences.values()) {
    const ceiling = memberCeiling(audience, self);
    if (ceiling !== null) integrations.set(audience.slug, ceiling);
  }
  return { traits: "all", integrations };
}

/** One Integration tool a member may call: the resolved Integration, the
 *  connector's raw tool name, its class, and whether the Org's curation
 *  asks before every call. The name is the Guild-facing namespaced one or
 *  the raw connector one (legacy int_ prefix tolerated). Throws 404 for an
 *  unknown Integration or tool, 403 when the member's reach excludes it. */
export async function memberTool(
  gateway: IntegrationGateway,
  access: IntegrationAccessStore,
  caller: IntegrationCaller,
  slug: string,
  tool: string,
): Promise<{ turn: IntegrationTurn; raw: string; class: string; alwaysAsk: boolean }> {
  const turn = (await turns(gateway, caller.org)).find((t) => t.slug === slug);
  if (turn === undefined) throw ApiError.notFound("no such integration");
  const info = turn.tools.find((i) => {
    const callRaw = unnamespacedTool(turn.slug, tool) ?? tool;
    const specRaw = unnamespacedTool(turn.slug, i.spec.name) ?? i.spec.name;
    return callRaw === specRaw;
  });
  if (info === undefined) throw ApiError.notFound("no such tool");
  const scope = await callerScope(access, caller);
  if (!toolOffered(turn, info, scopeCeiling(scope, turn.slug, info), caller.role)) {
    throw ApiError.forbidden("this tool is not available to you");
  }
  const raw = unnamespacedTool(turn.slug, info.spec.name) ?? info.spec.name;
  return {
    turn,
    raw,
    class: info.class,
    alwaysAsk: toolCurate(turn.rowConfig, raw).alwaysAsk,
  };
}

/** The outcome of one member call: a connector failure is a result, never
 *  an HTTP error. */
export type MemberToolResult = { ok: true; content: string; meta: unknown } | { ok: false; error: string };

/** Runs one Integration tool for a member through the connector runtime the
 *  chat loop uses (secrets re-resolved at call time, the identity envelope)
 *  and records the `integration.tool_called` audit event. */
export async function runMemberTool(
  gateway: IntegrationGateway,
  events: Pick<EventStore, "emit">,
  caller: IntegrationCaller,
  turn: IntegrationTurn,
  raw: string,
  args: JsonObject,
  actingAs: string | null,
  audit: { via: "script" | "app"; app_id?: string; function?: string },
): Promise<MemberToolResult> {
  const callId = crypto.randomUUID();
  const started = Date.now();
  let body: MemberToolResult;
  try {
    const outcome = await callPlugin(gateway, turn, raw, args, {
      orgId: caller.org,
      callerId: caller.userId,
      callId,
      actingAs,
    });
    body = { ok: true, content: outcome.content, meta: outcome.meta ?? null };
  } catch (error) {
    body = { ok: false, error: (error as Error).message };
  }
  try {
    await events.emit(caller.org, "integration.tool_called", {
      slug: turn.slug,
      call_id: callId,
      tool: raw,
      caller: caller.userId,
      acting_as: actingAs,
      ok: body.ok,
      ms: Date.now() - started,
      error: body.ok ? null : auditError(body.error),
      ...audit,
    });
  } catch {
    // Best-effort.
  }
  return body;
}
