// Desktop artifact metadata and digests in Postgres. Bytes are hosted on
// GitHub for imported releases or in object storage for uploaded artifacts.

import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";
import type { PlatformPool } from "../db.js";
import { withTransaction } from "../db.js";

export const APPROVED_RELEASE_VERSION_KV = "desktop_release_version";

/** GitHub-hosted bytes with the existing release wire shape. */
export interface GithubReleaseArtifact {
  id: string;
  version: string;
  platform: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  signature: string;
  updater_signature: string;
  download_url: string;
  notes: string;
}

export interface ReleaseRow {
  id: string;
  version: string;
  kind: string;
  platform: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  signature: string;
  updater_signature: string;
  notes: string;
  created_at: string;
}

export const PLATFORMS: readonly string[] = [
  "linux-x86_64",
  "linux-aarch64",
  "darwin-x86_64",
  "darwin-aarch64",
  "windows-x86_64",
];

export function validPlatform(p: string): boolean {
  return PLATFORMS.includes(p);
}

export function safeFilename(name: string): string | null {
  let cleaned = "";
  for (const c of name) {
    cleaned += /[a-zA-Z0-9.\-_]/.test(c) ? c : "_";
  }
  if (cleaned === "" || cleaned.length > 128 || cleaned.startsWith(".")) return null;
  return cleaned;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ROW_COLUMNS =
  "id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, " +
  utcText("created_at") +
  " AS created_at";

/** The wire shape, fields in wire order. */
function row(r: Record<string, unknown>): ReleaseRow {
  return {
    id: r.id as string,
    version: r.version as string,
    kind: r.kind as string,
    platform: r.platform as string,
    filename: r.filename as string,
    content_type: r.content_type as string,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256 as string,
    signature: r.signature as string,
    updater_signature: r.updater_signature as string,
    notes: r.notes as string,
    created_at: pgTimestampToRfc3339(r.created_at as string),
  };
}

export class ReleaseStore {
  constructor(readonly pool: PlatformPool) {}

  /** All six rows and the approved version become visible together. */
  async importGithub(artifacts: GithubReleaseArtifact[]): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      for (const a of artifacts) {
        await client.query(
          `INSERT INTO releases (id, version, kind, platform, filename, content_type, size_bytes,
            sha256, signature, updater_signature, notes, object_key, download_url)
           VALUES ($1, $2, 'desktop', $3, $4, 'application/octet-stream', $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (version, kind, platform, filename) DO UPDATE SET
             download_url = EXCLUDED.download_url, sha256 = EXCLUDED.sha256,
             size_bytes = EXCLUDED.size_bytes, signature = EXCLUDED.signature,
             updater_signature = EXCLUDED.updater_signature, notes = EXCLUDED.notes`,
          [
            a.id,
            a.version,
            a.platform,
            a.filename,
            a.size_bytes,
            a.sha256,
            a.signature,
            a.updater_signature,
            a.notes,
            `github/${a.version}/${a.platform}/${a.filename}`,
            a.download_url,
          ],
        );
      }
      await client.query(
        "INSERT INTO server_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [APPROVED_RELEASE_VERSION_KV, artifacts[0]!.version],
      );
    });
  }

  async downloadUrl(id: string): Promise<string | null> {
    const result = await this.pool.query("SELECT download_url FROM releases WHERE id = $1", [id]);
    if (result.rows.length === 0) throw ApiError.notFound("no such release");
    return result.rows[0]!.download_url as string | null;
  }

  async create(
    id: string,
    version: string,
    kind: string,
    platform: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
    sha256: string,
    signature: string,
    updaterSignature: string,
    notes: string,
    objectKey: string,
  ): Promise<ReleaseRow> {
    try {
      const res = await this.pool.query(
        `INSERT INTO releases (id, version, kind, platform, filename, content_type, size_bytes, sha256, signature, updater_signature, notes, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${ROW_COLUMNS}`,
        [
          id,
          version,
          kind,
          platform,
          filename,
          contentType,
          sizeBytes,
          sha256,
          signature,
          updaterSignature,
          notes,
          objectKey,
        ],
      );
      return row(res.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("release_taken", "an artifact with this version/kind/platform/filename already exists");
      }
      throw error;
    }
  }

  async list(): Promise<ReleaseRow[]> {
    const res = await this.pool.query(`SELECT ${ROW_COLUMNS} FROM releases ORDER BY created_at DESC`);
    return res.rows.map((r: Record<string, unknown>) => row(r));
  }

  async get(id: string): Promise<ReleaseRow> {
    const res = await this.pool.query(`SELECT ${ROW_COLUMNS} FROM releases WHERE id = $1`, [id]);
    const r = res.rows[0];
    if (r === undefined) throw ApiError.notFound("no such release");
    return row(r);
  }

  async delete(id: string): Promise<ReleaseRow> {
    const res = await this.pool.query(`DELETE FROM releases WHERE id = $1 RETURNING ${ROW_COLUMNS}`, [id]);
    const r = res.rows[0];
    if (r === undefined) throw ApiError.notFound("no such release");
    return row(r);
  }
}
