// Signed desktop releases: GitHub approval, downloads and the paired updater.
// Artifact bytes and updater signatures are hosted on GitHub.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireUser, requireAdminUser, queryParam, sendJson } from "./error.js";
import { APPROVED_RELEASE_VERSION_KV, type ReleaseRow, type GithubReleaseArtifact } from "../store/releases.js";
import { uuidv7 } from "../time.js";

async function githubJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw ApiError.badRequest(`GitHub release request failed (${response.status})`);
  return response.json();
}

/** Release metadata is accepted only from the configured public repository;
 * each artifact must match GitHub's own digest and size. */
async function githubArtifacts(
  repository: string,
  tag: string,
  previews: boolean,
  expectedCommit?: string,
): Promise<GithubReleaseArtifact[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw ApiError.badRequest("configure GUILD_RELEASE_REPOSITORY as owner/repository");
  if (!/^client-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-dev\.[1-9]\d*)?$/.test(tag))
    throw ApiError.badRequest("invalid client release tag");
  const version = tag.slice("client-v".length);
  if (version.includes("-") && !previews)
    throw ApiError.badRequest("develop releases require GUILD_RELEASE_CHANNEL=develop");
  const release = (await githubJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`)) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    body?: string;
    assets?: { name: string; size: number; digest: string; browser_download_url: string }[];
  };
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== version.includes("-") ||
    !Array.isArray(release.assets)
  ) {
    throw ApiError.badRequest("GitHub release is unpublished or its channel does not match the version");
  }
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  if (!release.assets.some((a) => a.name === "release.json" && a.browser_download_url === `${base}/release.json`)) {
    throw ApiError.badRequest("GitHub release is missing release.json");
  }
  const metadata = (await githubJson(`${base}/release.json`)) as {
    version?: string;
    commit?: string;
    repository?: string;
    tag?: string;
    artifacts?: { platform: string; filename: string; size_bytes: number; sha256: string; updater_signature: string }[];
  };
  if (
    metadata.version !== version ||
    metadata.repository !== repository ||
    metadata.tag !== tag ||
    !Array.isArray(metadata.artifacts) ||
    metadata.artifacts.length !== 6
  ) {
    throw ApiError.badRequest("invalid GitHub release metadata");
  }
  if (expectedCommit !== undefined && metadata.commit !== expectedCommit) {
    throw ApiError.badRequest("client release source commit does not match this server");
  }
  const result: GithubReleaseArtifact[] = [];
  for (const platform of ["windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    const filenames =
      platform === "windows-x86_64"
        ? [`Guild_${version}_x64-setup.exe`]
        : platform === "linux-x86_64"
          ? [`Guild-${version}-x86_64.AppImage`]
          : [
              `Guild-${version}-macos-${platform.slice(7)}.dmg`,
              `Guild-${version}-macos-${platform.slice(7)}.app.tar.gz`,
            ];
    for (const filename of filenames) {
      const artifact = metadata.artifacts.find((a) => a.platform === platform && a.filename === filename);
      const asset = release.assets.find((a) => a.name === filename);
      const signatureAsset = release.assets.find((a) => a.name === `${filename}.sig`);
      if (
        !artifact ||
        !asset ||
        !signatureAsset ||
        asset.browser_download_url !== `${base}/${filename}` ||
        signatureAsset.browser_download_url !== `${base}/${filename}.sig` ||
        !Number.isSafeInteger(artifact.size_bytes) ||
        artifact.size_bytes <= 0 ||
        asset.size !== artifact.size_bytes ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        asset.digest !== `sha256:${artifact.sha256}` ||
        typeof artifact.updater_signature !== "string" ||
        artifact.updater_signature.trim() === ""
      ) {
        throw ApiError.badRequest(`missing or unverified GitHub artifact: ${filename}`);
      }
      result.push({
        ...artifact,
        version,
        id: uuidv7(),
        download_url: `${base}/${filename}`,
        notes: release.body ?? "",
      });
    }
  }
  return result;
}

/** Semver ordering (semver.org §11): major/minor/patch numerically; a
 *  prerelease ranks BELOW its release; prerelease identifiers compare
 *  numerically when numeric, ASCII lexically otherwise, numeric <
 *  alphanumeric, and a longer identifier set outranks a prefix; build
 *  metadata is ignored. `gt(a, b)` = a > b strictly. */
export function versionGt(a: string, b: string): boolean {
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const nums = (core: string): number[] => core.split(".").map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0));
  const na = nums(coreA);
  const nb = nums(coreB);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  if (preA === null && preB === null) return false;
  if (preA === null) return true; // a release outranks any prerelease
  if (preB === null) return false;
  const idsA = preA.split(".");
  const idsB = preB.split(".");
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i];
    const y = idsB[i];
    if (x !== undefined && y !== undefined) {
      const nx = /^\d+$/.test(x) ? Number(x) : null;
      const ny = /^\d+$/.test(y) ? Number(y) : null;
      if (nx !== null && ny !== null) {
        if (nx > ny) return true;
        if (nx < ny) return false;
      } else if (nx !== null && ny === null) {
        return false; // numeric identifiers rank BELOW alphanumeric ones
      } else if (nx === null && ny !== null) {
        return true;
      } else if (x !== y) {
        return x > y;
      }
    } else if (x !== undefined) {
      return true; // longer set wins
    } else {
      return false;
    }
  }
  return false;
}

/** Splits `major.minor.patch[-prerelease][+build]`; build metadata is
 *  dropped, the prerelease (if any) is returned separately. */
function splitPrerelease(v: string): [string, string | null] {
  const noBuild = v.split("+")[0] ?? v;
  const dash = noBuild.indexOf("-");
  if (dash === -1) return [noBuild, null];
  return [noBuild.slice(0, dash), noBuild.slice(dash + 1)];
}

/** Whether `filename` is the updater bundle for `target` (plugin artifact
 *  kinds). */
function updaterArtifact(target: string, filename: string): boolean {
  switch (target) {
    case "linux-x86_64":
      return filename.endsWith(".AppImage");
    case "windows-x86_64":
      return filename.endsWith("-setup.exe");
    case "darwin-x86_64":
    case "darwin-aarch64":
      return filename.endsWith(".app.tar.gz");
    default:
      return false;
  }
}

export function registerReleaseRoutes(app: FastifyInstance, gateway: GatewayCtx, ctx: IdentityCtx): void {
  const channelFor = (req: FastifyRequest): "stable" | "develop" => {
    const channel = queryParam(req, "channel") ?? ctx.config.releaseChannel;
    if (channel !== "stable" && channel !== "develop") throw ApiError.badRequest("invalid release channel");
    return channel;
  };
  const eligible = (row: ReleaseRow, channel: "stable" | "develop"): boolean =>
    !versionGt(row.version, ctx.config.serverVersion) &&
    (channel === "stable" || ctx.config.releaseChannel === "develop") &&
    row.version.includes("-") === (channel === "develop");
  const approvedVersion = (channel: string) => ctx.kv.get(`${APPROVED_RELEASE_VERSION_KV}:${channel}`);
  const downloadRow = async (req: FastifyRequest, id: string): Promise<ReleaseRow> => {
    const row = await gateway.releases.get(id);
    const channel = channelFor(req);
    const approved = await approvedVersion(channel);
    if (!eligible(row, channel) || approved === null || versionGt(row.version, approved)) {
      throw ApiError.notFound("no compatible release on this channel");
    }
    return row;
  };

  app.post("/api/v1/admin/releases/github", async (req, reply) => {
    await requireAdminUser(ctx, req);
    if (ctx.config.releaseRepository === null) throw ApiError.badRequest("GUILD_RELEASE_REPOSITORY is not configured");
    const body = req.body as { tag?: unknown; source_commit?: unknown } | null;
    if (typeof body?.tag !== "string") throw ApiError.badRequest("tag is required");
    const sourceCommit = body.source_commit;
    if (sourceCommit !== undefined) {
      if (typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit) || sourceCommit !== ctx.config.serverCommit) {
        throw ApiError.badRequest("deployment source commit does not match this server");
      }
      if (body.tag !== `client-v${ctx.config.serverVersion}`) {
        throw ApiError.badRequest("deployment release version does not match this server");
      }
    }
    const artifacts = await githubArtifacts(
      ctx.config.releaseRepository,
      body.tag,
      ctx.config.releaseChannel === "develop",
      sourceCommit,
    );
    if (versionGt(artifacts[0]!.version, ctx.config.serverVersion)) {
      throw ApiError.badRequest("release is newer than this server");
    }
    await gateway.releases.importGithub(artifacts);
    sendJson(reply, { version: artifacts[0]!.version, artifacts: artifacts.length });
    return reply;
  });

  app.get("/api/v1/admin/releases", async (req, reply) => {
    await requireAdminUser(ctx, req);
    const rows = await gateway.releases.list();
    sendJson(reply, { releases: rows });
    return reply;
  });

  app.delete("/api/v1/admin/releases/:id", async (req, reply) => {
    await requireAdminUser(ctx, req);
    const id = parseUuidParam(req, "id");
    await gateway.releases.delete(id);
    sendJson(reply, {});
    return reply;
  });

  app.get("/api/v1/releases", async (req, reply) => {
    await requireUser(ctx, req);
    const channel = channelFor(req);
    const approved = await approvedVersion(channel);
    const rows = await gateway.releases.list();
    sendJson(reply, {
      releases: rows
        .filter((r) => eligible(r, channel) && approved !== null && !versionGt(r.version, approved))
        .sort((a, b) => (versionGt(a.version, b.version) ? -1 : versionGt(b.version, a.version) ? 1 : 0)),
    });
    return reply;
  });

  app.get("/api/v1/releases/:id/download-url", async (req, reply) => {
    await requireUser(ctx, req);
    const id = parseUuidParam(req, "id");
    const row = await downloadRow(req, id);
    sendJson(reply, { url: row.download_url });
    return reply;
  });

  app.get("/api/v1/releases/:id/download", async (req, reply) => {
    await requireUser(ctx, req);
    const row = await downloadRow(req, parseUuidParam(req, "id"));
    return reply.redirect(row.download_url);
  });

  // Tauri desktop auto-updater manifest. Public: static-JSON format from
  // the updater plugin, pointing at GitHub download URLs. Only
  // platforms with a signed updater artifact for the newest desktop version
  // are listed.
  app.get("/api/v1/updates/latest.json", async (req, reply) => {
    const channel = channelFor(req);
    const rows = await gateway.releases.list();
    const approved = await approvedVersion(channel);
    if (approved === null) return reply.status(204).send();
    let latest: { version: string; created_at: string } | null = null;
    for (const r of rows) {
      if (r.kind !== "desktop" || r.updater_signature === "") continue;
      if (!eligible(r, channel)) continue;
      if (r.version !== approved) continue;
      if (latest === null || versionGt(r.version, latest.version)) {
        latest = { version: r.version, created_at: r.created_at };
      }
    }
    if (latest === null) return reply.status(204).send();
    const platforms: Record<string, unknown> = {};
    for (const target of ["linux-x86_64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"]) {
      const row = rows.find(
        (r) =>
          r.kind === "desktop" &&
          r.version === latest!.version &&
          r.platform === target &&
          r.updater_signature !== "" &&
          updaterArtifact(target, r.filename),
      );
      if (row === undefined) continue;
      platforms[target] = {
        signature: row.updater_signature,
        url: row.download_url,
      };
    }
    if (Object.keys(platforms).length !== 4) return reply.status(204).send();
    const notes = rows.find((r) => r.version === latest!.version && r.notes !== "")?.notes ?? "";
    // The manifest object keys are sorted like every json!-built body;
    // pub_date renders with chrono's to_rfc3339 (+00:00 offset).
    sendJson(reply, {
      version: latest.version,
      server_version: ctx.config.serverVersion,
      channel,
      notes,
      pub_date: toRfc3339Offset(latest.created_at),
      platforms,
    });
    return reply;
  });
}

/** chrono's DateTime::to_rfc3339: UTC renders with a +00:00 offset, and the
 *  %.f fraction drops trailing zero groups (0 → absent). */
export function toRfc3339Offset(pgText: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?/.exec(pgText);
  if (m === null) throw new Error(`unexpected timestamp: ${pgText}`);
  let fraction = "";
  if (m[2] !== undefined) {
    const digits = m[2].replace(/0+$/, "");
    if (digits.length > 0) fraction = `.${digits.padEnd(digits.length <= 3 ? 3 : 6, "0")}`;
  }
  return `${m[1]}${fraction}+00:00`;
}
