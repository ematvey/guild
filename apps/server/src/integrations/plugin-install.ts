// Installing an integration bundle into an org: the one path a catalog
// install, an uploaded .guildplugin, and a pasted bundle URL all take. The
// admin who installs is the reviewer — the bundle is checked, published to
// the org's registry, approved at its exact hash, and given a disabled
// integration row the settings page completes. A code bundle is loaded once
// before anything is written, so a plugin.js that does not start never
// reaches the registry.

import { ApiError } from "../platform/errors.js";
import { parseBundle, readBundleFile } from "../platform/bundle.js";
import { BundleWriteError, bundleSha256, publishRegistryBundle, type Publisher } from "../platform/registry-publish.js";
import { singleLineDescription, validateV2, type Manifest } from "../platform/registry-manifest.js";
import type { RegistryStore } from "../platform/store/registry.js";
import type { IntegrationStore } from "../platform/store/integrations.js";
import type { TeamStore } from "../platform/store/teams.js";
import type { EventStore } from "../platform/store/events.js";
import type { ObjectStore } from "../platform/s3.js";
import { builtinByName } from "./loader.js";
import { CODE_ENTRY, loadCodePlugin } from "./code-plugins.js";

export interface PluginInstallDeps {
  readonly integrations: Pick<IntegrationStore, "getByName" | "upsert">;
  readonly registry: RegistryStore;
  readonly teams: Pick<TeamStore, "isMember">;
  readonly events: Pick<EventStore, "emit">;
  readonly objects: Pick<ObjectStore, "put">;
}

/** Where an installed bundle came from, for the org's activity feed. */
export type InstallOrigin = { kind: "catalog"; catalog: string } | { kind: "upload" } | { kind: "url"; url: string };

export interface InstalledPlugin {
  slug: string;
  version: string;
  sha256: string;
  runtime: "code" | "mcp";
  /** True when this install created the org's integration row. */
  created: boolean;
}

/** Installs one bundle for the publisher's org (see the module comment).
 *  Re-installing the version the registry already holds is a no-op
 *  republish plus a fresh approval of the same hash. */
export async function installPluginBundle(
  deps: PluginInstallDeps,
  publisher: Publisher,
  bytes: Buffer,
  origin: InstallOrigin,
): Promise<InstalledPlugin> {
  const orgId = publisher.orgId;
  const parsed = await parseBundle(bytes);
  const manifest = parsed.manifest as unknown as Manifest;
  try {
    validateV2(manifest);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  if (manifest.kind !== "integration") throw ApiError.badRequest("only integration bundles install here");
  const slug = manifest.slug as string;
  const version = manifest.version as string;
  const sha256 = bundleSha256(bytes);
  const isCode = manifest.runtime === "code";
  const isMcp = manifest.mcp !== null && manifest.mcp !== undefined;
  if (!isCode && !isMcp) throw ApiError.badRequest("the bundle is neither a code plugin nor an MCP integration");
  if (builtinByName(slug) !== undefined) {
    throw ApiError.conflict("slug_taken", `${slug} is the name of a built-in integration`);
  }
  if (isCode) {
    if (readBundleFile(parsed, CODE_ENTRY) === null) {
      throw ApiError.badRequest(`code plugin bundles must contain ${CODE_ENTRY} at the root`);
    }
    try {
      await loadCodePlugin(async () => bytes, sha256, slug, version);
    } catch (error) {
      throw ApiError.badRequest(`the plugin failed to start: ${(error as Error).message}`);
    }
  }
  const description = singleLineDescription(
    typeof manifest.summary === "string"
      ? manifest.summary
      : typeof manifest.description === "string"
        ? manifest.description
        : "",
  );
  try {
    await publishRegistryBundle(
      { registry: deps.registry, teams: deps.teams, events: deps.events, objects: deps.objects },
      publisher,
      { kind: "integration", slug, version, description, manifest },
      bytes,
    );
  } catch (error) {
    if (error instanceof BundleWriteError) throw ApiError.internal(error.message);
    throw error;
  }
  await deps.registry.setReview(orgId, "integration", slug, "approved", version, sha256);
  let created = false;
  if ((await deps.integrations.getByName(orgId, slug)) === null) {
    const config = isMcp
      ? {
          mcp: manifest.mcp,
          auth: manifest.auth ?? { kind: "org_secret", secret_names: [], identity_key: "email" },
          tool_policy: {},
        }
      : {};
    await deps.integrations.upsert(orgId, slug, config, false);
    created = true;
  }
  try {
    await deps.events.emit(orgId, "integration.plugin_installed", {
      integration: slug,
      version,
      sha256,
      origin,
      by: publisher.userId,
    });
  } catch {
    // best-effort audit
  }
  return { slug, version, sha256, runtime: isCode ? "code" : "mcp", created };
}
