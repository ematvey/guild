// Model provider wiring (spec decision 7): the pi-durable harness's model
// access is an OpenAI-compatible client pointed at the TS server's OWN
// gateway over loopback (`<self>/openai/v1`) with the internal key and the
// org-scoping header — quotas, key vault, model routing, and usage recording
// stay in one place; the built-in agent is metered exactly like external
// clients (the gateway's usage sink already records the internal calls).

import { createProvider, lazyApi, type MutableModels } from "@earendil-works/pi-ai";

/** Provider id namespace: one provider per org (the gateway route table and
 *  the internal-key org scoping are per-org; the harness resolves agent
 *  models as `guild:<orgId>/<model>`). */
export function guildProviderId(orgId: string): string {
  return `guild:${orgId}`;
}

/** The trace context one in-app turn rides on: every loopback model call
 *  the harness makes while this turn runs forwards it as request headers so
 *  the gateway's llm_calls rows carry chat/turn attribution and the chat
 *  owner's user id. Keyed by org — the provider (and therefore the auth
 *  resolve that merges the headers) is per-org; two same-org turns in
 *  flight overlap on the slot and the latest turn's context wins (best
 *  effort; the judge self-reports its rows with exact context). */
export interface GuildTurnTraceContext {
  orgId: string;
  chatId: string;
  conversationId: number;
  turn: number | null;
  userId: string | null;
}

const turnTraceContexts = new Map<string, GuildTurnTraceContext>();

/** Sets the trace context the org's next loopback model calls carry. */
export function setGuildTurnTraceContext(ctx: GuildTurnTraceContext): void {
  turnTraceContexts.set(ctx.orgId, ctx);
}

/** The current context's request headers (empty when none is set). */
export function guildTurnTraceHeaders(orgId: string): Record<string, string> {
  const ctx = turnTraceContexts.get(orgId);
  if (ctx === undefined) return {};
  const headers: Record<string, string> = {
    "x-guild-chat-id": ctx.chatId,
    "x-guild-conversation-id": String(ctx.conversationId),
    "x-guild-cause": "turn-step",
  };
  if (ctx.turn !== null) headers["x-guild-turn"] = String(ctx.turn);
  if (ctx.userId !== null) headers["x-guild-user-id"] = ctx.userId;
  return headers;
}

export interface GuildRouteInfo {
  /** The route's model name (what external clients call it). */
  model: string;
  reasoning: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
  /** Route prices ($/Mtok) — the durable assistant usage carries the cost
   *  exactly like the Rust worker's route-priced events. */
  price_in: number;
  price_out: number;
}

export interface GuildModelsConfig {
  /** Loopback base of this server's own gateway (config.selfBaseUrl). */
  selfBaseUrl: string;
  internalKey: string | null;
}

/** Ensures the models collection carries a provider for `orgId` exposing
 *  exactly the org's enabled gateway routes as OpenAI-compatible models.
 *  Re-registering replaces the provider in place (route edits apply on the
 *  next turn). */
export function ensureOrgProvider(
  models: MutableModels,
  config: GuildModelsConfig,
  orgId: string,
  routes: readonly GuildRouteInfo[],
): void {
  const id = guildProviderId(orgId);
  const baseUrl = `${config.selfBaseUrl.replace(/\/+$/, "")}/openai/v1`;
  const provider = createProvider({
    id,
    name: `Guild gateway (${orgId})`,
    baseUrl,
    // Static request auth: the internal key rides on every call (the
    // gateway authenticates it and reads the org from the header). The
    // apiKey resolve keeps Models' availability checks happy without a
    // credential store.
    headers: {
      Authorization: `Bearer ${config.internalKey ?? "missing"}`,
      "x-guild-org-id": orgId,
    },
    auth: {
      apiKey: {
        name: "Guild internal key",
        resolve: async () => ({
          auth: {
            // The stream call builds its own `Authorization: Bearer <apiKey>`
            // from the resolved key; the org scoping rides as a request
            // header resolved alongside it (applyAuth merges auth.headers
            // into every request — provider-level static headers do not
            // reach the stream path). The current turn's trace context
            // (chat/conversation/turn/owner) rides the same way.
            apiKey: config.internalKey ?? "missing",
            headers: {
              "x-guild-org-id": orgId,
              ...guildTurnTraceHeaders(orgId),
            },
          },
        }),
      },
    },
    api: openAiCompletionsApi(),
    models: routes.map((route) => ({
      id: route.model,
      name: route.model,
      api: "openai-completions" as const,
      provider: id,
      baseUrl,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: route.price_in, output: route.price_out, cacheRead: 0, cacheWrite: 0 },
      reasoning: route.reasoning,
      contextWindow: route.context_window ?? 128_000,
      maxTokens: route.max_output_tokens ?? 8_192,
    })),
  });
  models.setProvider(provider);
}

/** The OpenAI-completions API implementation, loaded on first stream call. */
function openAiCompletionsApi() {
  return lazyApi(async () => import("@earendil-works/pi-ai/api/openai-completions"));
}
