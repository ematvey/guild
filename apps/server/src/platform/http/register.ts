// Native-route registration: all M1 platform routes (auth, org, events,
// attachments, OIDC) live in one encapsulated Fastify plugin so their error
// handling and content parsers stay scoped — every un-ported path keeps
// flowing to the proxy catch-all, and rollback per area is deleting the
// route here.

import type { FastifyInstance } from "fastify";
import type { PlatformContext } from "../context.js";
import { installErrorHandling, RAW_BODY, JSON_REJECTION_PREFIX, TextError } from "./error.js";
import { registerAuthRoutes } from "./auth.js";
import { registerOrgRoutes } from "./org.js";
import { registerEventRoutes } from "./events.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { registerOidcRoutes } from "./oidc.js";
import { registerGatewayAdminRoutes } from "./gateway.js";
import { registerApiKeyRoutes } from "./api_keys.js";
import { registerUsageRoutes } from "./usage.js";
import { registerOpenAiRoutes, renderOpenAiError } from "./openai.js";
import { registerAnthropicRoutes, renderAnthropicError } from "./anthropic.js";

export interface NativeRouteGroup {
  /** Route group name (for the report / rollback notes). */
  name: string;
  /** Paths served natively; deleting the group's register call moves each
   *  one back to the proxy. */
  paths: string[];
}

export const NATIVE_ROUTE_GROUPS: NativeRouteGroup[] = [
  { name: "auth", paths: ["/api/v1/auth/*"] },
  { name: "org", paths: ["/api/v1/org", "/api/v1/org/logo", "/api/v1/orgs/*/logo"] },
  { name: "events", paths: ["/api/v1/events"] },
  { name: "attachments", paths: ["/api/v1/attachments/*", "/api/v1/chats/*/attachments"] },
  { name: "oidc", paths: ["/api/v1/auth/oidc/*", "/api/v1/admin/oidc"] },
  { name: "gateway-admin", paths: ["/api/v1/gateway/models", "/api/v1/admin/gateway/*"] },
  { name: "api-keys", paths: ["/api/v1/api-keys", "/api/v1/api-keys/*", "/api/v1/admin/api-keys", "/api/v1/admin/api-keys/*"] },
  { name: "usage", paths: ["/api/v1/usage", "/api/v1/usage/*"] },
  { name: "llm-gateway", paths: ["/openai/v1/*", "/anthropic/v1/*"] },
];

export async function registerPlatformRoutes(app: FastifyInstance, ctx: PlatformContext): Promise<void> {
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

    registerAuthRoutes(scope, ctx);
    registerOrgRoutes(scope, ctx);
    registerEventRoutes(scope, ctx);
    registerAttachmentRoutes(scope, ctx);
    registerOidcRoutes(scope, ctx);
    registerGatewayAdminRoutes(scope, ctx);
    registerApiKeyRoutes(scope, ctx);
    registerUsageRoutes(scope, ctx);
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
    registerOpenAiRoutes(scope, ctx, ctx);
    registerAnthropicRoutes(scope, ctx, ctx);
  });
}
