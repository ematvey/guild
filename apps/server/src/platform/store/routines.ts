// Routine records — only the creation path the registry install needs
// (crates/server/src/store/routines.rs create). Full routine CRUD is
// deferred with the routines feature (spec decision 8): the rows created
// here stay disabled until an owner enables them, and execution remains
// unreachable.

import { ApiError } from "../errors.js";
import { sha256Hex } from "../crypto.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";

export interface RoutineRow {
  id: string;
  org_id: string;
  created_by: string | null;
  slug: string;
  name: string;
  trigger_kind: string;
  trigger_config: unknown;
  prompt: string;
  model: string;
  allowed_tools: unknown;
  enabled: boolean;
  created_at: string;
}

function row(r: Record<string, unknown>): RoutineRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    created_by: (r.created_by as string | null) ?? null,
    slug: r.slug as string,
    name: r.name as string,
    trigger_kind: r.trigger_kind as string,
    trigger_config: r.trigger_config,
    prompt: r.prompt as string,
    model: r.model as string,
    allowed_tools: r.allowed_tools,
    enabled: r.enabled === true,
    created_at: pgTimestampToRfc3339(r.created_at as string),
  };
}

const ROUTINE_COLUMNS =
  "id, org_id, created_by, slug, name, trigger_kind, trigger_config, prompt, model, allowed_tools, enabled, " +
  "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at";

export class RoutineStore {
  constructor(readonly pool: PlatformPool) {}

  /** Webhook tokens are hashed at rest, like api keys and pairing codes. */
  private webhookTokenHash(token: string): string {
    return sha256Hex(token);
  }

  async create(
    orgId: string,
    createdBy: string | null,
    slug: string,
    name: string,
    triggerKind: string,
    triggerConfigIn: unknown,
    prompt: string,
    model: string,
    allowedTools: unknown,
    webhookToken: string,
    enabled: boolean,
  ): Promise<RoutineRow> {
    let triggerConfig = triggerConfigIn;
    if (triggerKind === "interval") {
      if (triggerConfig === null || typeof triggerConfig !== "object" || Array.isArray(triggerConfig)) {
        throw ApiError.badRequest("trigger_config must be an object");
      }
      triggerConfig = { ...(triggerConfig as Record<string, unknown>), schedule_generation: uuidv7() };
    }
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let inserted: RoutineRow;
      try {
        const res = await client.query(
          `INSERT INTO routines (id, org_id, created_by, slug, name, trigger_kind, trigger_config, prompt, model, allowed_tools, webhook_token_hash, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${ROUTINE_COLUMNS}`,
          [id, orgId, createdBy, slug, name, triggerKind, JSON.stringify(triggerConfig), prompt, model, JSON.stringify(allowedTools), this.webhookTokenHash(webhookToken), enabled],
        );
        inserted = row(res.rows[0]!);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw ApiError.conflict("slug_taken", "a routine with this slug already exists");
        }
        throw error;
      }
      // A created enabled interval routine starts its chain immediately.
      if (inserted.enabled && inserted.trigger_kind === "interval") {
        const generation = (inserted.trigger_config as Record<string, unknown>)["schedule_generation"];
        if (typeof generation !== "string") throw ApiError.internal("invalid schedule generation");
        await client.query(
          "INSERT INTO routine_schedule_starts (generation, routine_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [generation, inserted.id],
        );
      }
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** The routine by slug within an org (install dedup + lookup). */
  async getBySlug(orgId: string, slug: string): Promise<RoutineRow | null> {
    const res = await this.pool.query(
      `SELECT ${ROUTINE_COLUMNS} FROM routines WHERE org_id = $1 AND slug = $2`,
      [orgId, slug],
    );
    return res.rows[0] === undefined ? null : row(res.rows[0]);
  }
}
