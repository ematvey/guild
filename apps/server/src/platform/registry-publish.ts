// The one registry publish: content-addressed object key, the publish gate
// re-checked inside upsertVersion's row-lock transaction, the SKILL.md
// projection for skills, the object put, and the org event (first publish
// vs republish). The registry route, the skills editor and the agent's
// push_skill tool all land here.

import { createHash } from "node:crypto";
import type { ObjectStore } from "./s3.js";
import type { RegistryStore } from "./store/registry.js";
import type { TeamStore } from "./store/teams.js";
import type { EventStore } from "./store/events.js";
import { parseBundle, readBundleFile } from "./bundle.js";

/** Content-addressed: a republish with different bundle bytes lands at a
 *  new key, so superseded and supersede-attempt bundles are never
 *  overwritten in place. */
export function registryObjectKey(orgId: string, kind: string, slug: string, version: string, sha256: string): string {
  return `registry/${orgId}/${kind}/${slug}/${version}/${sha256}.tar.gz`;
}

export function bundleSha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RegistryPublishDeps {
  registry: Pick<RegistryStore, "itemControl" | "upsertVersion">;
  teams: Pick<TeamStore, "isMember">;
  events: Pick<EventStore, "emit">;
  objects: Pick<ObjectStore, "put">;
}

export interface Publisher {
  orgId: string;
  userId: string;
  role: string;
  /** The publisher's display label (display name or email) for the skill
   *  activity feed. */
  label: string;
}

/** The object store refused the bundle bytes after the version row was
 *  accepted; a retry re-writes the same content-addressed key. */
export class BundleWriteError extends Error {
  constructor(cause: unknown) {
    super(`object store write failed: ${(cause as Error).message}`);
    this.name = "BundleWriteError";
  }
}

/** Publishes one bundle version. Throws the gate's ApiError (403, 409) when
 *  the version is refused, BundleWriteError when the bytes could not be
 *  stored. Returns whether the slug was new. */
export async function publishRegistryBundle(
  deps: RegistryPublishDeps,
  publisher: Publisher,
  item: { kind: string; slug: string; version: string; description: string; manifest: unknown },
  bytes: Buffer,
): Promise<{ created: boolean }> {
  const { orgId, userId, role } = publisher;
  const { kind, slug, version } = item;
  const sha256 = bundleSha256(bytes);
  const key = registryObjectKey(orgId, kind, slug, version, sha256);

  // Pre-read for the team-membership input; the authoritative gate decision
  // happens inside upsertVersion's row-lock transaction.
  const control = await deps.registry.itemControl(orgId, kind, slug);
  const isTeamMember =
    control?.owner_team_id != null ? await deps.teams.isMember(orgId, control.owner_team_id, userId) : false;

  // Skill projection: SKILL.md text and the file list with per-file
  // hashes, stored on the version row for the panel and the editor.
  let skill: { md_text: string; files: Array<{ path: string; size: number; sha256: string }> } | null = null;
  if (kind === "skill") {
    const parsed = await parseBundle(bytes);
    skill = {
      md_text: readBundleFile(parsed, "SKILL.md")!.toString("utf8"),
      files: parsed.entries
        .filter((entry) => entry.file)
        .map((entry) => ({ path: entry.path, size: entry.content!.length, sha256: bundleSha256(entry.content!) })),
    };
  }

  // Metadata first: only an accepted upsert (new version, unchanged
  // republish) commits a row; a superseded publish is refused before any
  // bundle bytes land, so the old release's object stays intact.
  await deps.registry.upsertVersion(
    orgId,
    kind,
    slug,
    version,
    item.description,
    item.manifest,
    key,
    sha256,
    userId,
    skill,
    { userId, role, isTeamMember },
  );
  try {
    await deps.objects.put(key, bytes);
  } catch (error) {
    throw new BundleWriteError(error);
  }
  // The activity feed tells a first publish from a republish. Skill events
  // carry the publisher; best-effort.
  const actor = kind === "skill" ? { user_id: userId, actor: publisher.label } : {};
  try {
    await deps.events.emit(orgId, control !== null ? "registry.updated" : "registry.published", {
      kind,
      slug,
      version,
      ...actor,
    });
  } catch {
    // best-effort
  }
  return { created: control === null };
}
