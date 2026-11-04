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
import type { OrgKvStore } from "../platform/store/org-kv.js";
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

/** Org KV key of the trait bindings: `{ "<trait>": "<integration slug>" }`. */
export const TRAIT_BINDINGS_KEY = "integration_trait_bindings";

export type TraitBindings = Record<string, string>;

export async function readTraitBindings(kv: Pick<OrgKvStore, "get">, orgId: string): Promise<TraitBindings> {
  const raw = await kv.get(orgId, TRAIT_BINDINGS_KEY);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const known = new Set(traitNames());
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => known.has(entry[0]) && typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
  } catch {
    return {};
  }
}

/** Writes one binding; an empty provider clears it (back to the default
 *  order). */
export async function writeTraitBinding(
  kv: Pick<OrgKvStore, "get" | "put">,
  orgId: string,
  trait: string,
  provider: string | null,
): Promise<TraitBindings> {
  if (!traitNames().includes(trait)) throw new Error(`unknown trait ${trait}`);
  const bindings = await readTraitBindings(kv, orgId);
  if (provider === null || provider === "") delete bindings[trait];
  else bindings[trait] = provider;
  await kv.put(orgId, TRAIT_BINDINGS_KEY, JSON.stringify(bindings));
  return bindings;
}
