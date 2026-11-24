// The per-org loopback model providers: each org's enabled gateway routes
// registered as one provider in the process's model registry, with the
// trace headers every model call of a chat turn carries (chat, conversation,
// run, user). Also the one short model call that names a fresh thread.

import { createModels, type MutableModels } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { GatewayStore } from "../platform/store/gateway.js";
import type { OrgStore } from "../platform/store/orgs.js";
import type { AgentRunStore } from "../agents/store.js";
import type { TitleSource } from "../agents/thread-binding.js";
import { ensureOrgProvider, guildProviderId, type GuildRouteInfo } from "./models.js";
import { TITLE_SYSTEM, resolveGeneratedTitle } from "./title.js";

export interface OrgModelDeps {
  readonly config: Pick<Config, "selfBaseUrl" | "internalKey">;
  readonly log: Logger;
  readonly gateway: Pick<GatewayStore, "listRoutes">;
  readonly orgs: Pick<OrgStore, "listIds">;
  readonly chats: Pick<ChatStore, "ownerOf">;
  readonly agents: { readonly runs: Pick<AgentRunStore, "runningRunForChat"> };
}

/** How long a chat's running run id is reused for trace headers. */
const RUN_ID_TTL_MS = 2_000;

export class OrgModels {
  readonly models: MutableModels = createModels();
  /** Provider session id → the chat and conversation it serves. */
  private readonly sessions = new Map<string, { chatId: string; conversationId: number }>();
  /** Short-lived chat → running run id cache: one lookup per model call is
   *  too much, and a run id only matters while the turn is live. */
  private readonly runIds = new Map<string, { id: string | null; at: number }>();

  constructor(private readonly deps: OrgModelDeps) {}

  /** Names the chat a provider session serves (the trace headers' source). */
  bindSession(sessionId: string, chatId: string, conversationId: number): void {
    this.sessions.set(sessionId, { chatId, conversationId });
  }

  forgetConversation(conversationId: number): void {
    for (const [sessionId, source] of this.sessions) {
      if (source.conversationId === conversationId) this.sessions.delete(sessionId);
    }
  }

  /** A chat's run moved (a new turn, or its end): its cached run id is
   *  stale. */
  forgetRun(chatId: string): void {
    this.runIds.delete(chatId);
  }

  clear(): void {
    this.sessions.clear();
    this.runIds.clear();
  }

  /** Registers/refreshes every org's provider (startup: the resumed runs of
   *  a restart resolve models without a fresh submit). */
  async refreshAll(): Promise<void> {
    for (const orgId of await this.deps.orgs.listIds()) {
      await this.refresh(orgId).catch((error: unknown) =>
        this.deps.log.warn({ err: error, orgId }, "org model refresh failed"),
      );
    }
  }

  /** Registers/refreshes the org's provider from the gateway route table
   *  (the provider's model catalog = the org's enabled routes). */
  async refresh(orgId: string): Promise<void> {
    const routes = await this.deps.gateway.listRoutes(orgId);
    const infos: GuildRouteInfo[] = routes
      .filter((route) => route.enabled)
      .map((route) => ({
        model: route.model,
        reasoning: route.reasoning,
        context_window: route.context_window,
        max_output_tokens: route.max_output_tokens,
        price_in: route.price_per_mtok_in_usd,
        price_out: route.price_per_mtok_out_usd,
      }));
    ensureOrgProvider(
      this.models,
      {
        selfBaseUrl: this.deps.config.selfBaseUrl,
        internalKey: this.deps.config.internalKey,
        traceHeaders: async (sessionId): Promise<Record<string, string>> => {
          const source = sessionId === undefined ? undefined : this.sessions.get(sessionId);
          if (!source) return {};
          const owner = await this.deps.chats.ownerOf(source.chatId);
          const runId = await this.runningRunId(source.chatId);
          return {
            "x-guild-chat-id": source.chatId,
            "x-guild-conversation-id": String(source.conversationId),
            "x-guild-cause": "conversation-request",
            ...(runId !== null ? { "x-guild-run-id": runId } : {}),
            // Background activity keeps its organization-level usage identity.
            ...(owner && !owner.internal ? { "x-guild-user-id": owner.user_id } : {}),
          };
        },
      },
      orgId,
      infos,
    );
  }

  /** A title for a fresh thread from its first message; empty when the
   *  model is not routed or the reply names nothing. */
  async title(source: TitleSource): Promise<string> {
    let model = this.models.getModel(guildProviderId(source.orgId), source.model);
    if (model === undefined) {
      // This process has not registered the org's routes yet (the server in
      // worker mode); the title call is its first model use.
      await this.refresh(source.orgId);
      model = this.models.getModel(guildProviderId(source.orgId), source.model);
    }
    if (model === undefined) return "";
    const result = await this.models.completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Name this conversation:\n\n${source.firstMessage.slice(0, 2_000)}`,
            timestamp: Date.now(),
          },
        ],
      },
      // A reasoning route can spend the whole budget thinking before it
      // writes the title; the cap is generous and the fallback names the
      // thread when the reply is still empty.
      { maxTokens: 1_024, temperature: 0.3, reasoning: "minimal" },
    );
    const raw = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    return resolveGeneratedTitle(raw, source.firstMessage);
  }

  /** The chat's running agent run id, cached briefly: every model call in
   *  the turn carries it as the trace id. Null for plain chats. */
  private async runningRunId(chatId: string): Promise<string | null> {
    const cached = this.runIds.get(chatId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < RUN_ID_TTL_MS) return cached.id;
    const run = await this.deps.agents.runs.runningRunForChat(chatId).catch(() => null);
    const id = run?.id ?? null;
    this.runIds.set(chatId, { id, at: now });
    return id;
  }
}
