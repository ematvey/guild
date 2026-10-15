// Native-route registration: all M1 platform routes (auth, org, events,
// attachments, OIDC) live in one encapsulated Fastify plugin so their error
// handling and content parsers stay scoped — every un-ported path keeps
// flowing to the proxy catch-all, and rollback per area is deleting the
// route here.

import type { FastifyInstance } from "fastify";
import type { PlatformContext } from "../context.js";
import type { ChatsCtx, GatewayCtx, IdentityCtx, InfraContext } from "../contexts.js";
import { RAW_BODY, JSON_REJECTION_PREFIX, TextError } from "../errors.js";
import { installErrorHandling } from "./error.js";
import { registerAuthRoutes } from "./auth.js";
import { registerOrgRoutes } from "./org.js";
import { registerEventRoutes } from "./events.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerOidcRoutes } from "./oidc.js";
import { registerGatewayAdminRoutes } from "./gateway.js";
import { registerApiKeyRoutes } from "./api_keys.js";
import { registerUsageRoutes } from "./usage.js";
import { registerObservabilityRoutes } from "./observability.js";
import { registerChatsRoutes } from "./chats.js";
import { registerAgentSessionRoutes } from "./agents.js";
import { registerToolArtifactRoutes } from "./tool-artifacts.js";
import { registerThreadStreamRoute } from "./thread-stream.js";
import { registerOpenAiRoutes, renderOpenAiError } from "./openai.js";
import { registerAnthropicRoutes, renderAnthropicError } from "./anthropic.js";
import { registerMachineRoutes } from "../../http/machines.js";
import { registerWsRoutes } from "../../http/ws.js";
import { registerRegistryRoutes } from "./registry.js";
import { registerSkillRoutes } from "./skills.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerProjectRoutes } from "./projects.js";
import { registerTeamRoutes } from "./teams.js";
import { registerAdminUserRoutes, registerAdminPromptRoutes, registerAdminIntegrationRoutes } from "./admin.js";
import { registerIntegrationToolRoutes } from "./integration_tools.js";
import { registerUserMcpRoutes } from "./user_mcp.js";

export interface NativeRouteGroup {
  /** Route group name (for the report / rollback notes). */
  name: string;
  /** Paths served natively; deleting the group's register call moves each
   *  one back to the proxy. */
  paths: string[];
}

export const NATIVE_ROUTE_GROUPS: NativeRouteGroup[] = [
  { name: "auth", paths: ["/api/v1/auth/*", "/api/v1/me/approval"] },
  { name: "org", paths: ["/api/v1/org", "/api/v1/org/logo", "/api/v1/orgs/*/logo"] },
  { name: "events", paths: ["/api/v1/events"] },
  { name: "attachments", paths: ["/api/v1/attachments/*", "/api/v1/chats/*/attachments"] },
  { name: "oidc", paths: ["/api/v1/auth/oidc/*", "/api/v1/admin/oidc"] },
  { name: "gateway-admin", paths: ["/api/v1/gateway/models", "/api/v1/admin/gateway/*"] },
  { name: "api-keys", paths: ["/api/v1/api-keys", "/api/v1/api-keys/*", "/api/v1/admin/api-keys", "/api/v1/admin/api-keys/*"] },
  { name: "usage", paths: ["/api/v1/usage", "/api/v1/usage/*"] },
  { name: "observability", paths: ["/api/v1/observability", "/api/v1/observability/*", "/api/v1/admin/observability", "/api/v1/admin/observability/*"] },
  { name: "llm-gateway", paths: ["/openai/v1/*", "/anthropic/v1/*"] },
  { name: "machines", paths: ["/api/v1/machines", "/api/v1/machines/*"] },
  { name: "hub-ws", paths: ["/api/v1/ws/ticket"] },
  { name: "chats", paths: ["/api/v1/chats", "/api/v1/chats/*", "/api/v1/gateway/chat", "/api/v1/gateway/chat/*", "/api/v1/threads", "/api/v1/threads/*"] },
  // M6 long tail: registry, releases, projects, teams, admin users/prompts.
  { name: "registry", paths: ["/api/v1/registry/*"] },
  { name: "skills", paths: ["/api/v1/skills", "/api/v1/skills/*"] },
  { name: "releases", paths: ["/api/v1/releases", "/api/v1/releases/*", "/api/v1/admin/releases", "/api/v1/admin/releases/*", "/api/v1/updates/latest.json"] },
  { name: "projects", paths: ["/api/v1/projects", "/api/v1/projects/*"] },
  { name: "teams", paths: ["/api/v1/admin/teams", "/api/v1/admin/teams/*"] },
  { name: "admin-users", paths: ["/api/v1/admin/users", "/api/v1/admin/users/*"] },
  { name: "admin-prompts", paths: ["/api/v1/admin/assistant-prompt", "/api/v1/admin/approval-policy-prompt"] },
  // M7: the full admin integration CRUD (save path + tools listing
  // included) and the script-facing tool API. The execute route validates
  // identically but the runtime is deferred (spec decision 8): a validated
  // call fails with the connector-unreachable shape (200, ok:false).
  { name: "admin-integrations", paths: ["/api/v1/admin/integrations", "/api/v1/admin/integrations/*"] },
  { name: "integration-tools", paths: ["/api/v1/integrations", "/api/v1/integrations/*"] },
  { name: "user-mcp", paths: ["/api/v1/mcp", "/api/v1/mcp/*"] },
  // M4: workspace agent sessions + tool artifacts (the spill surface).
  { name: "agents", paths: ["/api/v1/agents/sessions", "/api/v1/agents/sessions/*"] },
  { name: "tool-artifacts", paths: ["/api/v1/tool_artifacts/*", "/api/v1/chats/*/tool_artifacts"] },
];

export async function registerPlatformRoutes(app: FastifyInstance, ctx: PlatformContext): Promise<void> {
  // Composition glue: the full context is sliced here and each route group
  // receives only the collaborators it uses.
  const infra: InfraContext = ctx;
  const auth: IdentityCtx = ctx;
  const chats: ChatsCtx = ctx;
  const gateway: GatewayCtx = ctx;

  await app.register(async (scope) => {
    installErrorHandling(scope);

    // Raw JSON parser: keeps the raw body text for serde-style column
    // positions and turns parse failures into axum-shaped text rejections.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as unknown as Record<symbol, string>)[RAW_BODY] = body as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body as string);
      } catch (error) {
        // axum renders JSON body parse failures as plain text with this
        // prefix; the tail is parser-specific (serde vs V8 detail).
        done(
          new TextError(400, `${JSON_REJECTION_PREFIX}${error instanceof Error ? error.message : String(error)}`),
          undefined,
        );
        return;
      }
      done(null, parsed);
    });

    // Binary bodies (attachment uploads, logo uploads): raw bytes, any
    // content type — axum Bytes semantics. Scoped here so the proxy keeps
    // its streaming passthrough for everything else.
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    registerAuthRoutes(scope, auth, ctx.pool);
    registerOrgRoutes(scope, auth, ctx.objects);
    registerEventRoutes(scope, auth);
    registerAttachmentRoutes(scope, auth, infra);
    registerOidcRoutes(scope, auth);
    registerGatewayAdminRoutes(scope, gateway, auth);
    registerApiKeyRoutes(scope, auth);
    registerUsageRoutes(scope, auth, infra);
    registerObservabilityRoutes(scope, auth, infra);
    // M5 hub core: machine registry routes + the ws-ticket mint (the /api/v1/ws
    // upgrade itself is a server-level 'upgrade' listener, not an HTTP route).
    registerMachineRoutes(scope, chats, auth);
    registerWsRoutes(scope, chats, auth);
    registerChatsRoutes(scope, chats, gateway, auth, ctx.objects);
    registerAgentSessionRoutes(scope, chats, gateway, auth, ctx.config);
    registerToolArtifactRoutes(scope, chats, auth, infra);
    registerThreadStreamRoute(scope, chats, auth, ctx.pool);
    // M6 long tail.
    registerRegistryRoutes(scope, gateway, auth, ctx.objects);
    registerSkillRoutes(scope, gateway, auth, ctx.objects, ctx.skills, {
      onInstallChange: (orgId, userId) => ctx.runtime.skillsRuntime.syncUser(orgId, userId),
      runtime: ctx.runtime.skillsRuntime,
    });
    registerReleaseRoutes(scope, gateway, auth, ctx.objects);
    registerProjectRoutes(scope, gateway, auth);
    registerTeamRoutes(scope, auth);
    registerAdminUserRoutes(scope, auth);
    registerAdminPromptRoutes(scope, auth);
    registerAdminIntegrationRoutes(scope, gateway, auth);
    registerUserMcpRoutes(scope, auth);
  });

  // The script-facing integration tool API accepts ANY content type as raw
  // bytes (axum Bytes semantics in the Rust route) and renders its own
  // envelope, so it lives in its own encapsulated plugin with a catch-all
  // buffer parser — the platform scope's JSON parser would 415/serde-reject
  // non-JSON bodies instead of the route's "body must be a JSON object".
  await app.register(async (scope) => {
    installErrorHandling(scope);
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
    registerIntegrationToolRoutes(scope, auth, gateway);
  });

  // The LLM gateway surfaces (/openai/v1, /anthropic/v1) render errors in
  // their own wire contracts, so they live in a separate encapsulated
  // plugin with the same raw-JSON parser but a per-shape error handler —
  // not the /api/v1 envelope. The shape follows the request path.
  await app.register(async (scope) => {
    installErrorHandling(scope, (error, path) =>
      path.startsWith("/anthropic") ? renderAnthropicError(error) : renderOpenAiError(error),
    );
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as unknown as Record<symbol, string>)[RAW_BODY] = body as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body as string);
      } catch (error) {
        done(
          new TextError(400, `${JSON_REJECTION_PREFIX}${error instanceof Error ? error.message : String(error)}`),
          undefined,
        );
        return;
      }
      done(null, parsed);
    });
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
    registerOpenAiRoutes(scope, gateway);
    registerAnthropicRoutes(scope, gateway);
  });
}
