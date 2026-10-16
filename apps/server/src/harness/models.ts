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
  traceHeaders?(sessionId: string | undefined): Promise<Record<string, string>>;
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
  // An empty route read must not wipe the org's live catalog: the provider
  // is rebuilt on every submit, and a transient empty read here once failed
  // a running turn mid-flight with "model is not available" (no_model). The
  // stale catalog keeps serving; the gateway rejects a genuinely removed
  // route with a proper error at call time.
  if (routes.length === 0) return;
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
            // reach the stream path). Trace headers are added per request
            // using the durable provider-session identity.
            apiKey: config.internalKey ?? "missing",
            headers: {
              "x-guild-org-id": orgId,
            },
          },
        }),
      },
    },
    api: openAiCompletionsApi(config),
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
function openAiCompletionsApi(config: GuildModelsConfig) {
  return lazyApi(async () => {
    const api = await import("@earendil-works/pi-ai/api/openai-completions");
    const tracedFetch =
      (sessionId: string | undefined): typeof fetch =>
      async (input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const trace = await config.traceHeaders?.(sessionId);
        for (const [name, value] of Object.entries(trace ?? {})) headers.set(name, value);
        return fetch(input, { ...init, headers });
      };
    return {
      stream: (model, context, options) =>
        api.stream({ ...model, api: "openai-completions" }, context, {
          ...options,
          fetch: tracedFetch(options?.sessionId),
        }),
      streamSimple: (model, context, options) =>
        api.streamSimple({ ...model, api: "openai-completions" }, context, {
          ...options,
          fetch: tracedFetch(options?.sessionId),
        }),
    } satisfies import("@earendil-works/pi-ai").ProviderStreams;
  });
}
