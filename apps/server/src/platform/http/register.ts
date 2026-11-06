// Platform route registration: every /api/v1 route group, the script-facing
// integration tool API, and the LLM gateway surfaces, each in an
// encapsulated Fastify plugin so its error rendering and content parsers
// stay scoped to it.

import type { FastifyInstance } from "fastify";
import type { PlatformContext } from "../../composition.js";
import type { ChatsCtx, GatewayCtx, IdentityCtx, InfraContext } from "../route-contexts.js";
import { ApiError, TextError } from "../errors.js";
import { JSON_REJECTION_PREFIX } from "../llm-gateway.js";
import { installErrorHandling, jsonContentParser } from "./error.js";
import { registerAuthRoutes } from "./auth.js";
import { registerOrgRoutes } from "./org.js";
import { registerEventRoutes } from "./events.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerPreviewLinkRoutes } from "./preview-link.js";
import { registerOidcRoutes } from "./oidc.js";
import { registerGatewayAdminRoutes } from "./gateway.js";
import { registerApiKeyRoutes } from "./api-keys.js";
import { registerPushRoutes } from "./push.js";
import { registerUsageRoutes } from "./usage.js";
import { registerActivityRoutes } from "./activity.js";
import { registerChatsRoutes } from "./chats.js";
import { registerToolArtifactRoutes } from "./tool-artifacts.js";
import { registerOpenAiRoutes, renderOpenAiError } from "./openai.js";
import { registerAnthropicRoutes, renderAnthropicError } from "./anthropic.js";
import { registerMachineRoutes } from "./machines.js";
import { registerWsRoutes } from "./ws.js";
import { registerRegistryRoutes } from "./registry.js";
import { registerSkillRoutes } from "./skills.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerProjectRoutes } from "./projects.js";
import { registerTeamRoutes } from "./teams.js";
import { registerAdminUserRoutes, registerAdminPromptRoutes, registerAdminIntegrationRoutes } from "./admin.js";
import { registerPluginCatalogRoutes } from "./plugin-catalogs.js";
import { registerIntegrationToolRoutes } from "./integration-tools.js";
import { registerUserMcpRoutes } from "./user-mcp.js";
import { registerAgentRoutes } from "./agents.js";

export async function registerPlatformRoutes(app: FastifyInstance, ctx: PlatformContext): Promise<void> {
  // Composition glue: the full context is sliced here and each route group
  // receives only the collaborators it uses.
  const infra: InfraContext = ctx;
  const auth: IdentityCtx = ctx;
  const chats: ChatsCtx = ctx;
  const gateway: GatewayCtx = ctx;

  await app.register(async (scope) => {
    installErrorHandling(scope);

    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      jsonContentParser(() => ApiError.badRequest("request body is not valid JSON")),
    );

    // Binary bodies (attachment uploads, logo uploads, bundles): raw bytes,
    // any content type.
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    registerAuthRoutes(scope, auth);
    registerOrgRoutes(scope, auth, ctx.objects);
    registerEventRoutes(scope, auth);
    registerAttachmentRoutes(scope, auth, infra, chats.chats);
    registerOidcRoutes(scope, auth);
    registerGatewayAdminRoutes(scope, gateway, auth);
    registerApiKeyRoutes(scope, auth);
    registerPushRoutes(scope, auth, ctx.pushNotifier);
    registerUsageRoutes(scope, auth, infra);
    registerActivityRoutes(scope, auth, infra);
    // Machine registry routes + the ws-ticket mint (the /api/v1/ws upgrade
    // itself is a server-level 'upgrade' listener, not an HTTP route).
    registerMachineRoutes(scope, chats, auth);
    registerWsRoutes(scope, chats, auth);
    registerChatsRoutes(scope, chats, gateway, auth, ctx.objects);
    registerToolArtifactRoutes(scope, chats, auth, infra);
    registerPreviewLinkRoutes(scope, chats, auth);
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
    registerAdminIntegrationRoutes(scope, gateway, auth, ctx.objects);
    registerPluginCatalogRoutes(scope, gateway, auth);
    registerUserMcpRoutes(scope, auth);
    registerAgentRoutes(scope, auth, infra, chats, gateway, ctx.objects);
  });

  // The script-facing integration tool API accepts ANY content type as raw
  // bytes and renders its own envelope, so it lives in its own encapsulated
  // plugin with a catch-all buffer parser — the platform scope's JSON parser
  // would reject non-JSON bodies instead of the route's "body must be a
  // JSON object".
  await app.register(async (scope) => {
    installErrorHandling(scope);
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
    registerIntegrationToolRoutes(scope, auth, gateway);
  });

  // The LLM gateway surfaces (/openai/v1, /anthropic/v1) render errors in
  // their own wire contracts, so they live in a separate encapsulated
  // plugin with a per-shape error handler — not the /api/v1 envelope. The
  // shape follows the request path.
  await app.register(async (scope) => {
    installErrorHandling(scope, (error, path) =>
      path.startsWith("/anthropic") ? renderAnthropicError(error) : renderOpenAiError(error),
    );
    // The raw body text is kept: it is the request payload the trace
    // captures, and a parse failure is a plain-text rejection.
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      jsonContentParser((detail) => new TextError(400, `${JSON_REJECTION_PREFIX}${detail}`)),
    );
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
    registerOpenAiRoutes(scope, gateway);
    registerAnthropicRoutes(scope, gateway);
  });
}
