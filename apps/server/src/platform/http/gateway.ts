// Provider administration and the user-facing model list (crates/server/
// src/http/gateway.rs — the route/provider/admin part only; the chat
// turn-submission routes stay proxied until the M3 cutover).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { requireJsonBody, requireUser } from "./error.js";
import { rustFloat, rustJsonText } from "../provider/sse.js";
import type { PlatformContext } from "../context.js";
import { PROTOCOLS, providerSlug } from "../store/gateway.js";

/** The authenticated user from the session table, requiring the admin role. */
async function requireAdminUser(ctx: PlatformContext, req: FastifyRequest) {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}

export function registerGatewayAdminRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  // User-facing: the org's enabled models.
  app.get("/api/v1/gateway/models", async (req) => {
    const user = await requireUser(ctx, req);
    const list = await ctx.gatewayStore.listModels(user.org_id);
    return rustJsonText({ models: list });
  });

  app.get("/api/v1/admin/gateway/routes", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const rows = await ctx.gatewayStore.listRoutes(admin.org_id);
    // f64 columns keep serde's ryu rendering (0 → "0.0").
    const rendered = rows.map((r) => ({
      ...r,
      price_per_mtok_in_usd: rustFloat(r["price_per_mtok_in_usd"] as number),
      price_per_mtok_out_usd: rustFloat(r["price_per_mtok_out_usd"] as number),
      quota_monthly_usd: r["quota_monthly_usd"] === null ? null : rustFloat(r["quota_monthly_usd"] as number),
    }));
    return rustJsonText({ routes: rendered });
  });

  app.put("/api/v1/admin/gateway/routes", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const body = requireJsonBody(req);
    const model = body["model"];
    if (typeof model !== "string") throw ApiError.badRequest("missing model");
    const provider = body["provider"];
    if (typeof provider !== "string") throw ApiError.badRequest("missing provider");
    const enabled = body["enabled"] === undefined ? true : body["enabled"] === true;
    const quotaMonthlyUsd = typeof body["quota_monthly_usd"] === "number" ? body["quota_monthly_usd"] : null;
    const reasoning = body["reasoning"] === undefined ? false : body["reasoning"] === true;
    const contextWindow = typeof body["context_window"] === "number" ? body["context_window"] : null;
    const maxOutputTokens = typeof body["max_output_tokens"] === "number" ? body["max_output_tokens"] : null;
    if (maxOutputTokens !== null && maxOutputTokens <= 0) {
      // A nonpositive cap means "no cap" nowhere in the proxy: through
      // min() it would erase a positive client limit — reject it.
      throw ApiError.badRequest("max_output_tokens must be a positive integer");
    }
    const priceIn = body["price_in"];
    if (typeof priceIn !== "number") throw ApiError.badRequest("missing price_in");
    const priceOut = body["price_out"];
    if (typeof priceOut !== "number") throw ApiError.badRequest("missing price_out");
    // Native input modalities: subset of {image, audio, video}.
    const modalities = Array.isArray(body["modalities"])
      ? (body["modalities"] as unknown[])
          .filter((m): m is string => typeof m === "string")
          .filter((m) => m === "image" || m === "audio" || m === "video")
      : [];
    await ctx.gatewayStore.upsertRoute(
      admin.org_id,
      model,
      provider,
      enabled,
      priceIn,
      priceOut,
      quotaMonthlyUsd,
      reasoning,
      contextWindow,
      maxOutputTokens,
      modalities,
    );
    return rustJsonText({});
  });

  app.delete("/api/v1/admin/gateway/routes/:model", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const model = (req.params as Record<string, string>)["model"] ?? "";
    await ctx.gatewayStore.deleteRoute(admin.org_id, model);
    return rustJsonText({});
  });

  app.get("/api/v1/admin/gateway/providers", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const providers = await ctx.gatewayStore.listProviders(admin.org_id, ctx.masterKey());
    return rustJsonText({ providers });
  });

  // Creates a provider: {name, protocol, base_url, key}. The slug routes
  // reference is derived from the name; duplicates are 409.
  app.post("/api/v1/admin/gateway/providers", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const body = requireJsonBody(req);
    const name = readNonEmpty(body["name"]) ? (body["name"] as string).trim() : null;
    if (name === null) throw ApiError.badRequest("missing name");
    const protocol = body["protocol"];
    if (typeof protocol !== "string") throw ApiError.badRequest("missing protocol");
    if (!PROTOCOLS.includes(protocol)) {
      throw ApiError.badRequest(`unknown protocol ${protocol} — expected one of: ${PROTOCOLS.join(", ")}`);
    }
    const baseUrl = readNonEmpty(body["base_url"]) ? (body["base_url"] as string).trim() : null;
    if (baseUrl === null) throw ApiError.badRequest("missing base_url");
    const key = typeof body["key"] === "string" && body["key"] !== "" ? body["key"] : null;
    if (key === null) throw ApiError.badRequest("missing key");
    const slug = providerSlug(name);
    const existing = await ctx.gatewayStore.getProvider(admin.org_id, slug, ctx.masterKey());
    if (existing !== null) {
      throw ApiError.conflict("already_exists", `a provider with the name '${name}' already exists`);
    }
    await ctx.gatewayStore.createProvider(admin.org_id, slug, name, protocol, baseUrl, key, ctx.masterKey());
    return rustJsonText({ provider: slug });
  });

  // Updates a provider: {name, protocol, base_url, key?} — a blank key
  // keeps the current one.
  app.put("/api/v1/admin/gateway/providers/:slug", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const slug = (req.params as Record<string, string>)["slug"] ?? "";
    const body = requireJsonBody(req);
    const name = readNonEmpty(body["name"]) ? (body["name"] as string).trim() : null;
    if (name === null) throw ApiError.badRequest("missing name");
    const protocol = body["protocol"];
    if (typeof protocol !== "string") throw ApiError.badRequest("missing protocol");
    if (!PROTOCOLS.includes(protocol)) {
      throw ApiError.badRequest(`unknown protocol ${protocol} — expected one of: ${PROTOCOLS.join(", ")}`);
    }
    const baseUrl = readNonEmpty(body["base_url"]) ? (body["base_url"] as string).trim() : null;
    if (baseUrl === null) throw ApiError.badRequest("missing base_url");
    const key = typeof body["key"] === "string" && body["key"] !== "" ? body["key"] : null;
    const updated = await ctx.gatewayStore.updateProvider(
      admin.org_id,
      slug,
      name,
      protocol,
      baseUrl,
      key,
      ctx.masterKey(),
    );
    if (!updated) throw ApiError.notFound(`no provider ${slug}`);
    return rustJsonText({});
  });

  // Removes a provider; routes referencing it stop resolving until a new
  // provider with the same slug is created.
  app.delete("/api/v1/admin/gateway/providers/:slug", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const slug = (req.params as Record<string, string>)["slug"] ?? "";
    await ctx.gatewayStore.deleteProvider(admin.org_id, slug);
    return rustJsonText({});
  });
}

function readNonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}
