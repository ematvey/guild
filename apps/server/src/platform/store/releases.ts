// GitHub desktop artifact metadata and digests in Postgres.

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
  size_bytes: number;
  sha256: string;
  updater_signature: string;
  notes: string;
  download_url: string;
  created_at: string;
}

const ROW_COLUMNS =
  "id, version, kind, platform, filename, size_bytes, sha256, updater_signature, notes, download_url, " +
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
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256 as string,
    updater_signature: r.updater_signature as string,
    notes: r.notes as string,
    download_url: r.download_url as string,
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
          `INSERT INTO releases (id, version, kind, platform, filename, size_bytes,
            sha256, updater_signature, notes, download_url)
           VALUES ($1, $2, 'desktop', $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (version, kind, platform, filename) DO UPDATE SET
             download_url = EXCLUDED.download_url, sha256 = EXCLUDED.sha256,
             size_bytes = EXCLUDED.size_bytes,
             updater_signature = EXCLUDED.updater_signature, notes = EXCLUDED.notes`,
          [
            a.id,
            a.version,
            a.platform,
            a.filename,
            a.size_bytes,
            a.sha256,
            a.updater_signature,
            a.notes,
            a.download_url,
          ],
        );
      }
      await client.query(
        "INSERT INTO server_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [
          `${APPROVED_RELEASE_VERSION_KV}:${artifacts[0]!.version.includes("-") ? "develop" : "stable"}`,
          artifacts[0]!.version,
        ],
      );
    });
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
