// Signed desktop downloads and updater manifests for the running build.
// Artifact bytes and updater signatures are hosted on GitHub.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireUser, queryParam, sendJson } from "./error.js";
import { uuidv5 } from "../time.js";

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
  expectedCommit: string,
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw ApiError.badRequest("configure GUILD_RELEASE_REPOSITORY as owner/repository");
  if (!/^client-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-dev\.[1-9]\d*)?$/.test(tag))
    throw ApiError.badRequest("invalid client release tag");
  const version = tag.slice("client-v".length);
  const release = (await githubJson(`https://api.github.com/repos/${repository}/releases/tags/${tag}`)) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
    body?: string;
    published_at?: string;
    assets?: { name: string; size: number; digest: string; browser_download_url: string }[];
  };
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== version.includes("-") ||
    !release.published_at || !Number.isFinite(Date.parse(release.published_at)) ||
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
  if (metadata.commit !== expectedCommit) {
    throw ApiError.badRequest("client release source commit does not match this server");
  }
  const result = [];
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
        id: uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", `${base}/${filename}`),
        version,
        kind: "desktop",
        platform,
        filename,
        size_bytes: artifact.size_bytes,
        sha256: artifact.sha256,
        updater_signature: artifact.updater_signature,
        created_at: release.published_at,
        download_url: `${base}/${filename}`,
        notes: release.body ?? "",
      });
    }
  }
  return result;
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

export function registerReleaseRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  let resolution: {
    key: string;
    retryAt: number;
    rows: ReturnType<typeof githubArtifacts>;
  } | undefined;
  const channelOf = () => ctx.config.serverVersion.includes("-dev.") ? "develop" : "stable";
  const channelFor = (req: FastifyRequest): "stable" | "develop" => {
    const channel = queryParam(req, "channel") ?? channelOf();
    if (channel !== "stable" && channel !== "develop") throw ApiError.badRequest("invalid release channel");
    return channel;
  };
  const releases = async (channel: "stable" | "develop") => {
    const { releaseRepository, serverVersion, serverCommit } = ctx.config;
    if (channel !== channelOf() || !releaseRepository || !serverCommit || !/^[a-f0-9]{40}$/.test(serverCommit)) {
      return [];
    }
    const key = JSON.stringify([releaseRepository, serverVersion, serverCommit]);
    if (resolution?.key === key && Date.now() < resolution.retryAt) return resolution.rows;

    // Coalesce updater checks. Published tags are immutable, while an
    // unavailable release gets retried without a GitHub request per client.
    const entry = {
      key,
      retryAt: Infinity,
      rows: githubArtifacts(releaseRepository, `client-v${serverVersion}`, serverCommit),
    };
    entry.rows = entry.rows.catch((error) => {
      entry.retryAt = Date.now() + 60_000;
      app.log.warn({ err: error, version: serverVersion }, "desktop release unavailable");
      return [];
    });
    resolution = entry;
    return entry.rows;
  };
  const downloadRow = async (req: FastifyRequest) => {
    const id = parseUuidParam(req, "id");
    const row = (await releases(channelFor(req))).find((item) => item.id === id);
    if (row === undefined) throw ApiError.notFound("no such release for this deployment");
    return row;
  };

  app.get("/api/v1/releases", async (req, reply) => {
    await requireUser(ctx, req);
    return sendJson(reply, { releases: await releases(channelFor(req)) });
  });

  app.get("/api/v1/releases/:id/download-url", async (req, reply) => {
    await requireUser(ctx, req);
    return sendJson(reply, { url: (await downloadRow(req)).download_url });
  });

  app.get("/api/v1/releases/:id/download", async (req, reply) => {
    await requireUser(ctx, req);
    return reply.redirect((await downloadRow(req)).download_url);
  });

  app.get("/api/v1/updates/latest.json", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const channel = channelFor(req);
    const rows = await releases(channel);
    if (rows.length === 0) return reply.status(204).send();
    const platforms = Object.fromEntries(
      rows.filter((row) => updaterArtifact(row.platform, row.filename)).map((row) => [
        row.platform,
        { signature: row.updater_signature, url: row.download_url },
      ]),
    );
    return sendJson(reply, {
      version: rows[0]!.version,
      server_version: ctx.config.serverVersion,
      channel,
      notes: rows[0]!.notes,
      pub_date: toRfc3339Offset(rows[0]!.created_at),
      platforms,
    });
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
