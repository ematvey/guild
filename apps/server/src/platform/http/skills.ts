// Skill surface (spec §1): the catalog the Skills panel renders — editor
// save (create/edit), search, detail, source, install/pin, maintainer
// gate, unpublish, fork, activity feed. Skills publish through the same
// internals as the registry route (publishBundleBytes) — server-assembled
// bundles, content-addressed, auto-versioned; no review gate (§1.3).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../contexts.js";
import type { ObjectStore } from "../s3.js";
import type { SkillStore } from "../store/skills.js";
import type { UserRow } from "../store/identity.js";
import type { SkillRuntime } from "../../harness/skills.js";
import { ApiError } from "../errors.js";
import { requireUser } from "./error.js";
import { rustJsonText } from "../provider/sse.js";
import { singleLineDescription, validateManifest, type Manifest } from "../registry-manifest.js";
import { packBundle, parseBundle } from "../bundle.js";
import { nextVersion } from "../store/registry.js";
import { publishBundleBytes } from "./registry.js";

export interface SkillRouteOptions {
  /** Install/pin changes fan out to the user's machines (Task 8 wires the
   *  skills runtime's syncUser; unset stays a no-op). */
  onInstallChange?: (orgId: string, userId: string) => void | Promise<void>;
  /** The skills runtime — the connect-time pull route serves its
   *  syncPayload (the machine's desired install list). */
  runtime?: SkillRuntime;
}

function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}

function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? "";
}

function queryOne(req: FastifyRequest, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function jsonBody(req: FastifyRequest): Record<string, unknown> {
  return (req.body !== null && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw ApiError.badRequest(`missing ${name}`);
  return value;
}

/** Assembles the server-side bundle for editor saves (spec §1.1): the
 *  manifest the registry already validates + SKILL.md; content-addressed
 *  like any other publish. */
function buildSkillBundle(slug: string, version: string, description: string, bodyText: string): Buffer {
  const manifest: Manifest = { kind: "skill", slug, version, description };
  try {
    validateManifest(manifest);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  return packBundle({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "SKILL.md": Buffer.from(bodyText, "utf8"),
  });
}

/** Owner-or-admin (spec §1.2): the owner user, a member of the owner team,
 *  or an org admin may gate/unpublish. */
async function assertCanManage(
  auth: IdentityCtx,
  user: UserRow,
  control: NonNullable<Awaited<ReturnType<GatewayCtx["registry"]["itemControl"]>>>,
): Promise<void> {
  if (user.role === "admin") return;
  if (control.owner_user_id !== null && control.owner_user_id === user.id) return;
  if (
    control.owner_team_id !== null &&
    (await auth.teams.isMember(user.org_id, control.owner_team_id, user.id))
  ) {
    return;
  }
  throw ApiError.forbidden();
}

/** Best-effort org event emission (the feed must never fail a route). */
async function emitEvent(
  auth: IdentityCtx,
  orgId: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  try {
    await auth.events.emit(orgId, kind, payload);
  } catch {
    // best-effort
  }
}

/** The owner display entry for the wire (user label = display name or
 *  email; team label = team name). */
async function ownerEntry(
  skills: SkillStore,
  orgId: string,
  ownerUserId: string | null,
  ownerTeamId: string | null,
): Promise<{ kind: "user" | "team"; id: string; label: string } | null> {
  return skills.ownerEntry(orgId, ownerUserId, ownerTeamId);
}

async function actorLabel(skills: SkillStore, orgId: string, userId: string): Promise<string> {
  return (await skills.ownerEntry(orgId, userId, null))?.label ?? userId;
}

/** Publishing auto-installs for the publisher: the same install record,
 *  event and machine-sync fan-out a manual install takes, pinned at the
 *  pushed version (a later publish re-pins; other users' installs are
 *  untouched). Never fails the publish — a failed install logs. */
async function autoInstall(
  skills: SkillStore,
  auth: IdentityCtx,
  onInstallChange: (orgId: string, userId: string) => void | Promise<void>,
  orgId: string,
  userId: string,
  slug: string,
  version: string,
): Promise<void> {
  try {
    await skills.install(orgId, userId, slug, version);
    await emitEvent(auth, orgId, "skill.installed", {
      slug,
      version,
      user_id: userId,
      actor: await actorLabel(skills, orgId, userId),
    });
    await onInstallChange(orgId, userId);
  } catch (error) {
    console.warn(`auto-install after publish failed for ${slug}: ${(error as Error).message}`);
  }
}

/** Applies the create payload's owner pick: owner_team_id requires team
 *  membership and moves ownership off the creating user. */
async function applyOwnerTeam(
  gateway: GatewayCtx,
  auth: IdentityCtx,
  user: UserRow,
  slug: string,
  ownerTeamId: string | undefined,
): Promise<void> {
  if (ownerTeamId === undefined) return;
  if (!(await auth.teams.isMember(user.org_id, ownerTeamId, user.id))) {
    throw ApiError.forbidden();
  }
  await gateway.registry.setOwnerTeam(user.org_id, "skill", slug, ownerTeamId);
}

export function registerSkillRoutes(
  app: FastifyInstance,
  gateway: GatewayCtx,
  auth: IdentityCtx,
  objects: ObjectStore,
  skills: SkillStore,
  options: SkillRouteOptions = {},
): void {
  const onInstallChange = options.onInstallChange ?? (() => {});
  const runtime = options.runtime;

  app.post("/api/v1/skills", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = jsonBody(req);
    const slug = stringField(body, "slug");
    const description =
      typeof body["description"] === "string" ? singleLineDescription(body["description"] as string) : "";
    const ownerTeamId = typeof body["owner_team_id"] === "string" ? body["owner_team_id"] : undefined;
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control !== null && !control.tombstoned) {
      throw ApiError.conflict("slug_taken", "a skill with this slug already exists");
    }

    // Fork (spec §1.2): seed a new slug from an existing version's bundle.
    const forkedFrom = typeof body["forked_from"] === "string" ? body["forked_from"] : undefined;
    if (forkedFrom !== undefined) {
      const at = forkedFrom.lastIndexOf("@");
      const sourceSlug = at > 0 ? forkedFrom.slice(0, at) : forkedFrom;
      const fromVersion =
        typeof body["from_version"] === "string" ? body["from_version"] : at > 0 ? forkedFrom.slice(at + 1) : undefined;
      const sourceVersion = fromVersion ?? (await gateway.registry.itemControl(user.org_id, "skill", sourceSlug))?.latest_version;
      if (sourceVersion === undefined || sourceVersion === null) {
        throw ApiError.notFound("no such source skill");
      }
      const meta = await gateway.registry.getVersionMeta(user.org_id, "skill", sourceSlug, sourceVersion);
      if (meta === null) throw ApiError.notFound("no such source skill version");
      let bytes: Buffer;
      try {
        bytes = await objects.get(meta.object_key);
      } catch (error) {
        throw ApiError.internal(`object store read failed: ${(error as Error).message}`);
      }
      const parsed = await parseBundle(bytes);
      const sourceManifest = meta.manifest as { description?: unknown } | null;
      const forkDescription = singleLineDescription(
        description !== "" ? description : typeof sourceManifest?.description === "string" ? sourceManifest.description : "",
      );
      const manifest: Manifest = { kind: "skill", slug, version: "v1", description: forkDescription };
      try {
        validateManifest(manifest);
      } catch (error) {
        throw ApiError.badRequest((error as Error).message);
      }
      const files: Record<string, Buffer> = { "manifest.json": Buffer.from(JSON.stringify(manifest)) };
      for (const entry of parsed.entries) {
        if (entry.file && entry.path !== "manifest.json") files[entry.path] = entry.content!;
      }
      await publishBundleBytes(
        gateway, auth, objects, user, "skill", slug, "v1", forkDescription, manifest, packBundle(files),
      );
      const provenance = `${sourceSlug}@${sourceVersion}`;
      await gateway.registry.setForkedFrom(user.org_id, "skill", slug, provenance);
      await applyOwnerTeam(gateway, auth, user, slug, ownerTeamId);
      await emitEvent(auth, user.org_id, "registry.forked", {
        slug,
        version: "v1",
        forked_from: provenance,
        user_id: user.id,
        actor: await actorLabel(skills, user.org_id, user.id),
      });
      await autoInstall(skills, auth, onInstallChange, user.org_id, user.id, slug, "v1");
      sendJson(reply, { slug, version: "v1" });
      return reply;
    }

    // Editor save. A tombstoned slug republishes fresh (spec §1.2: the
    // slug is reusable) — the tombstone clears and the next auto version
    // lands; a live duplicate refuses.
    if (control !== null) {
      await gateway.registry.clearTombstone(user.org_id, "skill", slug);
    }
    const bodyText = stringField(body, "body");
    const versions = await gateway.registry.itemVersions(user.org_id, "skill", slug);
    // Max-suffix arithmetic (never count-based): a legacy raw-route gap
    // (v1,v3) must yield v4, not a silent overwrite of v3.
    const version = nextVersion(versions);
    await publishBundleBytes(
      gateway, auth, objects, user, "skill", slug, version, description,
      { kind: "skill", slug, version, description },
      buildSkillBundle(slug, version, description, bodyText),
    );
    await applyOwnerTeam(gateway, auth, user, slug, ownerTeamId);
    await autoInstall(skills, auth, onInstallChange, user.org_id, user.id, slug, version);
    sendJson(reply, { slug, version });
    return reply;
  });

  app.put("/api/v1/skills/:slug", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const body = jsonBody(req);
    const description = singleLineDescription(stringField(body, "description"));
    const bodyText = stringField(body, "body");
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null || control.tombstoned) throw ApiError.notFound("no such skill");
    const versions = await gateway.registry.itemVersions(user.org_id, "skill", slug);
    const version = nextVersion(versions);
    await publishBundleBytes(
      gateway, auth, objects, user, "skill", slug, version, description,
      { kind: "skill", slug, version, description },
      buildSkillBundle(slug, version, description, bodyText),
    );
    await autoInstall(skills, auth, onInstallChange, user.org_id, user.id, slug, version);
    sendJson(reply, { slug, version });
    return reply;
  });

  app.get("/api/v1/skills/activity", async (req, reply) => {
    const user = await requireUser(auth, req);
    const filter = queryOne(req, "filter") ?? "all";
    if (filter !== "all" && filter !== "changes") throw ApiError.badRequest("filter must be all or changes");
    // "changes" = authorship events (spec §1.1); "all" adds install/pin
    // activity and unpublish.
    const kinds =
      filter === "changes"
        ? ["registry.published", "registry.updated", "registry.forked"]
        : ["registry.%", "skill.%"];
    const events = await auth.events.listKindPrefixed(user.org_id, kinds, 200);
    sendJson(reply, {
      events: events.map((ev) => ({ ts: ev.created_at, kind: ev.kind, payload: ev.payload })),
    });
    return reply;
  });

  app.get("/api/v1/skills/teams", async (req, reply) => {
    const user = await requireUser(auth, req);
    // The caller's team memberships (spec §1.2): the editor's owner
    // selector offers Me plus one option per team.
    sendJson(reply, { teams: await auth.teams.listTeamsForUser(user.org_id, user.id) });
    return reply;
  });

  app.get("/api/v1/skills/installs", async (req, reply) => {
    const user = await requireUser(auth, req);
    // The caller's own org installs (spec §3): one row per installed
    // skill, with its pinned version — the local tab's org-installs
    // list and the context.ts merge read this.
    sendJson(reply, { installs: await skills.listForUser(user.org_id, user.id) });
    return reply;
  });

  app.get("/api/v1/skills", async (req, reply) => {
    const user = await requireUser(auth, req);
    const q = queryOne(req, "q") ?? null;
    const rows = await skills.catalog(user.org_id, q);
    const items = await Promise.all(
      rows.map(async (r) => ({
        slug: r.slug,
        description: r.description,
        latest_version: r.latest_version,
        owner: await ownerEntry(skills, user.org_id, r.owner_user_id, r.owner_team_id),
        maintainer_gated: r.maintainer_gated,
        installs: r.installs,
        installs_latest: r.installs_latest,
        tombstoned: false,
      })),
    );
    sendJson(reply, { items });
    return reply;
  });

  app.get("/api/v1/skills/sync-payload", async (req, reply) => {
    const user = await requireUser(auth, req);
    if (runtime === undefined) throw ApiError.notFound("no skills runtime");
    sendJson(reply, await runtime.syncPayload(user.org_id, user.id));
    return reply;
  });

  app.get("/api/v1/skills/:slug", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    // Tombstoned skills keep their detail page (provenance survives
    // unpublish); only the catalog/search hide them.
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null) throw ApiError.notFound("no such skill");
    const versions = await gateway.registry.itemVersions(user.org_id, "skill", slug);
    // Read analytics (spec §3): totals (30d) + per-day series (14d) from
    // ClickHouse; the sink degrades to 0/[] when ClickHouse is unavailable.
    const [installs, pinCounts, myInstall, owner, readTotals, readSeries] = await Promise.all([
      skills.installCount(user.org_id, slug),
      skills.pinCounts(user.org_id, slug),
      skills.byUserAndSlug(user.org_id, user.id, slug),
      ownerEntry(skills, user.org_id, control.owner_user_id, control.owner_team_id),
      gateway.skillReads.readsBySlug(user.org_id, slug, 30),
      gateway.skillReads.readsByDay(user.org_id, slug, 14),
    ]);
    sendJson(reply, {
      slug,
      description: control.description,
      latest_version: control.latest_version,
      versions,
      forked_from: control.forked_from,
      maintainer_gated: control.maintainer_gated,
      owner,
      installs,
      pin_counts: pinCounts,
      my_install: myInstall,
      read_stats: { total: readTotals, series: readSeries },
      tombstoned: control.tombstoned,
    });
    return reply;
  });

  app.get("/api/v1/skills/:slug/source", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null) throw ApiError.notFound("no such skill");
    // Version resolution: explicit query → the user's pinned version →
    // latest.
    const version =
      queryOne(req, "version") ??
      (await skills.byUserAndSlug(user.org_id, user.id, slug))?.pinned_version ??
      control.latest_version;
    if (version === undefined || version === null) throw ApiError.notFound("no such skill version");
    const meta = await gateway.registry.getVersionMeta(user.org_id, "skill", slug, version);
    if (meta === null) throw ApiError.notFound("no such skill version");
    sendJson(reply, {
      version,
      skill_md: meta.skill_md_text ?? "",
      // manifest.json is bundle metadata (never materialized on installs) —
      // keep it out of the agent-facing file list.
      files: (meta.files ?? []).filter((f) => f.path !== "manifest.json"),
    });
    return reply;
  });

  app.post("/api/v1/skills/:slug/install", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null || control.tombstoned) throw ApiError.notFound("no such skill");
    const version =
      typeof jsonBody(req)["version"] === "string" ? (jsonBody(req)["version"] as string) : control.latest_version;
    if (version === null) throw ApiError.notFound("no such skill version");
    await gateway.registry.getVersion(user.org_id, "skill", slug, version); // 404 when missing
    const install = await skills.install(user.org_id, user.id, slug, version);
    await emitEvent(auth, user.org_id, "skill.installed", {
      slug,
      version,
      user_id: user.id,
      actor: await actorLabel(skills, user.org_id, user.id),
    });
    await onInstallChange(user.org_id, user.id);
    sendJson(reply, { install });
    return reply;
  });

  app.delete("/api/v1/skills/:slug/install", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    await skills.uninstall(user.org_id, user.id, slug);
    await emitEvent(auth, user.org_id, "skill.uninstalled", {
      slug,
      user_id: user.id,
      actor: await actorLabel(skills, user.org_id, user.id),
    });
    await onInstallChange(user.org_id, user.id);
    sendJson(reply, {});
    return reply;
  });

  app.post("/api/v1/skills/:slug/pin", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const version = stringField(jsonBody(req), "version");
    await gateway.registry.getVersion(user.org_id, "skill", slug, version); // 404 when missing
    const install = await skills.setPin(user.org_id, user.id, slug, version);
    await emitEvent(auth, user.org_id, "skill.pinned", {
      slug,
      version,
      user_id: user.id,
      actor: await actorLabel(skills, user.org_id, user.id),
    });
    await onInstallChange(user.org_id, user.id);
    sendJson(reply, { install });
    return reply;
  });

  app.post("/api/v1/skills/:slug/gate", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const body = jsonBody(req);
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null) throw ApiError.notFound("no such skill");
    await assertCanManage(auth, user, control);
    const enabled = body["enabled"];
    if (typeof enabled !== "boolean") throw ApiError.badRequest("enabled must be a boolean");
    await gateway.registry.setGate(user.org_id, "skill", slug, enabled);
    sendJson(reply, {});
    return reply;
  });

  app.post("/api/v1/skills/:slug/unpublish", async (req, reply) => {
    const user = await requireUser(auth, req);
    const slug = param(req, "slug");
    const control = await gateway.registry.itemControl(user.org_id, "skill", slug);
    if (control === null) throw ApiError.notFound("no such skill");
    await assertCanManage(auth, user, control);
    await gateway.registry.markUnpublished(user.org_id, "skill", slug);
    await emitEvent(auth, user.org_id, "registry.unpublished", {
      slug,
      user_id: user.id,
      actor: await actorLabel(skills, user.org_id, user.id),
    });
    sendJson(reply, {});
    return reply;
  });
}
