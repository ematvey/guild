// The connectors one org can run: the built-ins compiled into the server
// plus the code plugins the org installed from its registry (an approved
// integration bundle with `runtime: "code"`). A built-in slug always names
// the built-in; the registry refuses a code bundle that reuses one.
//
// Trait bindings live here too: each org picks which integration answers a
// trait (web_search, web_fetch). Without a binding, the first enabled
// provider in connector order wins it.

import type { ObjectStore } from "../platform/s3.js";
import type { RegistryStore } from "../platform/store/registry.js";
import { withTransaction, type PoolClient } from "../platform/db.js";
import {
  lockTraitBindings,
  parseTraitBindings,
  TRAIT_BINDINGS_KEY,
  type OrgKvStore,
} from "../platform/store/org-kv.js";
import { traitNames } from "@guild/integration-sdk";
import { BUILTINS, builtinByName, type Connector } from "./loader.js";
import { isCodeManifest, loadCodePlugin } from "./code-plugins.js";
import type { JsonObject } from "./shared.js";

/** The stores a registry connector loads through. */
export interface ConnectorSource {
  readonly registry: Pick<RegistryStore, "approvedBundle" | "getVersion" | "listItems">;
  readonly objects: Pick<ObjectStore, "get">;
}

/** The org's approved code plugin of one slug, or null when the slug has no
 *  approved code bundle. Throws when the approved bundle fails to load. */
export async function registryConnector(src: ConnectorSource, orgId: string, slug: string): Promise<Connector | null> {
  const approved = await src.registry.approvedBundle(orgId, "integration", slug);
  if (approved === null) return null;
  const [version, sha256] = approved;
  const stored = await src.registry.getVersion(orgId, "integration", slug, version);
  if (!isCodeManifest(stored.manifest as JsonObject | null)) return null;
  if (stored.bundle_sha256 !== sha256) {
    throw new Error(`integration ${slug}: stored bundle no longer matches the approved hash`);
  }
  return loadCodePlugin(() => src.objects.get(stored.object_key), sha256, slug, version);
}

/** The connector serving one slug for one org: the built-in of that name,
 *  else the org's approved code plugin. */
export async function connectorFor(src: ConnectorSource, orgId: string, name: string): Promise<Connector | undefined> {
  const builtin = builtinByName(name);
  if (builtin !== undefined) return builtin;
  return (await registryConnector(src, orgId, name)) ?? undefined;
}

/** Every connector of the org in priority order: the built-ins, then its
 *  approved code plugins by slug. A plugin that fails to load is skipped
 *  with a warning. */
export async function orgConnectors(
  src: ConnectorSource,
  orgId: string,
  warn: (message: string) => void = () => {},
): Promise<Connector[]> {
  const out = [...BUILTINS];
  const items = (await src.registry.listItems(orgId, "integration"))
    .filter((item) => item.review_status === "approved" && builtinByName(item.slug) === undefined)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  for (const item of items) {
    try {
      const connector = await registryConnector(src, orgId, item.slug);
      if (connector !== null) out.push(connector);
    } catch (error) {
      warn((error as Error).message);
    }
  }
  return out;
}

export type TraitBindings = Record<string, string>;

export async function readTraitBindings(kv: Pick<OrgKvStore, "get">, orgId: string): Promise<TraitBindings> {
  return parseTraitBindings(await kv.get(orgId, TRAIT_BINDINGS_KEY));
}

/** Writes one binding while serializing with instance slug changes. */
export async function writeTraitBinding(
  kv: OrgKvStore,
  orgId: string,
  trait: string,
  provider: string | null,
  validate: (client: PoolClient) => Promise<void>,
): Promise<TraitBindings> {
  if (!traitNames().includes(trait)) throw new Error(`unknown trait ${trait}`);
  return withTransaction(kv.pool, async (client) => {
    await lockTraitBindings(client, orgId);
    await validate(client);
    const bindings = parseTraitBindings(await kv.get(orgId, TRAIT_BINDINGS_KEY, client));
    if (provider === null) delete bindings[trait];
    else bindings[trait] = provider;
    await kv.put(orgId, TRAIT_BINDINGS_KEY, JSON.stringify(bindings), client);
    return bindings;
  });
}
