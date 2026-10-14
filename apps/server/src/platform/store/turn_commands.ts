// Durable accepted chat commands. The rows keep the gateway's idempotency
// contract (user_message_id
// dedupe + the `command_ack` response shape) and the generating-flag
// bookkeeping; delivery itself is the pi-durable submission (the bridge
// flips running/completed from run_start/run_end — no outbox pump, the
// admission is synchronous and durable).

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";

export interface TurnCommand {
  id: string;
  org_id: string;
  user_id: string;
  chat_id: string;
  request: unknown;
  payload: unknown;
  status: string;
  invocation_id: string | null;
  /** Arrival order (BIGSERIAL) — the queue order and the run's originating
   *  delivery (the earliest position = the generation identity). */
  position: number | null;
}

export class TurnCommandStore {
  constructor(private readonly pool: PlatformPool) {}

  /** The command row when `id` was accepted for exactly this
   *  (org, user, chat, request); a reused id with a different command is
   *  the Rust `command_id_conflict`. */
  async existing(
    id: string,
    org: string,
    user: string,
    chat: string,
    request: unknown,
  ): Promise<TurnCommand | undefined> {
    const res = await this.pool.query<TurnCommand & { request: unknown }>(
      "SELECT id, org_id, user_id, chat_id, request, payload, status, invocation_id FROM turn_commands WHERE id = $1",
      [id],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    if (row.org_id !== org || row.user_id !== user || row.chat_id !== chat || !deepEq(row.request, request)) {
      throw new ApiError(409, "command_id_conflict", "message ID was already used for a different command");
    }
    return row;
  }

  /** Atomic acceptance (Rust accept, minus the Restate payload fields the
   *  durable workflow carried — the TS submission path passes its own
   *  payload): the command row and the visible user_message echo either
   *  both commit or neither does. Locks the chat row (archived chats
   *  reject), applies an explicit project binding, inserts the command and
   *  the thread event under one id, and notifies the thread channel. */
  async accept(
    id: string,
    org: string,
    user: string,
    chat: string,
    request: unknown,
    payload: unknown,
    userEvent: { content: string; attachments: unknown[] },
  ): Promise<TurnCommand> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requestedProject =
        typeof (request as Record<string, unknown>)["project_id"] === "string"
          ? ((request as Record<string, unknown>)["project_id"] as string)
          : null;
      let binding: { project: string; machine_id: string | null; label: string | null } | undefined;
      if (requestedProject) {
        const proj = await client.query<{ machine_id: string | null; label: string | null }>(
          `SELECT p.machine_id, m.label FROM projects p
           LEFT JOIN machines m ON m.machine_id = p.machine_id
           WHERE p.id = $1 AND p.org_id = $2 FOR UPDATE OF p`,
          [requestedProject, org],
        );
        if (proj.rows[0]) {
          binding = {
            project: requestedProject,
            machine_id: proj.rows[0].machine_id,
            label: proj.rows[0].label,
          };
        }
      }
      const chatRow = await client.query<{
        project_id: string | null;
        machine_id: string | null;
        machine_label: string | null;
        archived_at: string | null;
      }>("SELECT project_id, machine_id, machine_label, archived_at FROM chats WHERE id = $1 AND org_id = $2 FOR UPDATE", [
        chat,
        org,
      ]);
      if (!chatRow.rows[0]) throw new ApiError(404, "not_found", "no such chat");
      const current = chatRow.rows[0];
      if (current.archived_at !== null) {
        throw new ApiError(409, "chat_archived", "chat is archived — unarchive it to send");
      }
      const payloadObj = payload as Record<string, unknown>;
      if ((request as Record<string, unknown>)["project_id"] === undefined) {
        payloadObj["project_id"] = current.project_id;
        payloadObj["machine_id"] = current.machine_id;
        payloadObj["machine_label"] = current.machine_label;
      }
      const inserted = await client.query(
        "INSERT INTO turn_commands (id, org_id, user_id, chat_id, request, payload) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT (id) DO NOTHING",
        [id, org, user, chat, JSON.stringify(request), JSON.stringify(payload)],
      );
      const rowRes = await client.query<TurnCommand>(
        "SELECT id, org_id, user_id, chat_id, request, payload, status, invocation_id FROM turn_commands WHERE id = $1",
        [id],
      );
      const row = rowRes.rows[0]!;
      if (row.org_id !== org || row.user_id !== user || row.chat_id !== chat || !deepEq(row.request, request)) {
        throw new ApiError(409, "command_id_conflict", "message ID was already used for a different command");
      }
      if (inserted.rowCount === 1) {
        if (binding) {
          if (binding.machine_id !== null || binding.label !== null) {
            await client.query("UPDATE chats SET project_id=$2, machine_id=$3, machine_label=$4 WHERE id=$1", [
              chat,
              binding.project,
              binding.machine_id,
              binding.label,
            ]);
          } else {
            await client.query("UPDATE chats SET project_id=$2 WHERE id=$1", [chat, binding.project]);
          }
        }
        const eventPayload = JSON.stringify({ type: "user_message", content: userEvent.content, attachments: userEvent.attachments });
        const eventRes = await client.query(
          "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1,$2,'user_message',$3::jsonb) ON CONFLICT (id) DO NOTHING",
          [id, chat, eventPayload],
        );
        if (eventRes.rowCount !== 1) {
          throw new ApiError(409, "command_id_conflict", "message ID already identifies a thread event");
        }
        await client.query("SELECT pg_notify('guild_thread_committed', $1)", [chat]);
      }
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Marks the command submitted to the durable conversation
   *  (invocation_id = the submission id). */
  async submitted(id: string, invocation: string): Promise<void> {
    await this.pool.query(
      "UPDATE turn_commands SET invocation_id = coalesce(invocation_id,$2), status = CASE WHEN status = 'pending' THEN 'submitted' ELSE status END WHERE id = $1",
      [id, invocation],
    );
  }

  /** The command enters its run (the bridge's run_start). None = unknown
   *  command (legacy); Some(false) = someone else's / already finished. */
  async begin(id: string, chat: string, invocation: string): Promise<boolean | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ status: string; invocation_id: string | null }>(
        "SELECT status, invocation_id FROM turn_commands WHERE id = $1 AND chat_id = $2 FOR UPDATE",
        [id, chat],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      if (row.status === "running") {
        await client.query("COMMIT");
        return row.invocation_id === invocation;
      }
      const archived = await client.query<{ archived: boolean }>(
        "SELECT archived_at IS NOT NULL AS archived FROM chats WHERE id = $1",
        [chat],
      );
      if (archived.rows[0]?.archived) {
        await client.query(
          "UPDATE turn_commands SET status = 'cancelled', finished_at = coalesce(finished_at, now()) WHERE id = $1 AND finished_at IS NULL",
          [id],
        );
        await client.query("COMMIT");
        return false;
      }
      if (row.status !== "pending" && row.status !== "submitted") {
        await client.query("COMMIT");
        return false;
      }
      if (row.invocation_id !== null && row.invocation_id !== invocation) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        "UPDATE turn_commands SET status = 'running', invocation_id = $2, started_seq = coalesce(started_seq, nextval(pg_get_serial_sequence('thread_events','seq'))) WHERE id = $1",
        [id, invocation],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(id: string, invocation: string, failed: boolean): Promise<void> {
    await this.pool.query(
      "UPDATE turn_commands SET status = $3, finished_at = coalesce(finished_at, now()) WHERE id = $1 AND invocation_id = $2 AND finished_at IS NULL",
      [id, invocation, failed ? "failed" : "completed"],
    );
  }

  /** Marks a withdrawn (aborted / archived) command cancelled — only an
   *  unfinished one; a settled row keeps its outcome. */
  async settleCancelled(id: string, invocation: string): Promise<void> {
    await this.pool.query(
      "UPDATE turn_commands SET status = 'cancelled', finished_at = coalesce(finished_at, now()) WHERE id = $1 AND invocation_id = $2 AND finished_at IS NULL",
      [id, invocation],
    );
  }

  /** Cancels the oldest unfinished command of a chat (stop / archive
   *  settles queued successors). */
  async cancelWaitingHead(chat: string): Promise<void> {
    await this.pool.query(
      "UPDATE turn_commands SET status = 'cancelled', finished_at = now() WHERE id = (SELECT id FROM turn_commands WHERE chat_id = $1 AND finished_at IS NULL ORDER BY position LIMIT 1) AND status IN ('pending','submitted')",
      [chat],
    );
  }

  /** Cancels every unfinished command of a chat (archiving). */
  async cancelAllWaiting(chat: string): Promise<void> {
    await this.pool.query(
      "UPDATE turn_commands SET status = 'cancelled', finished_at = now() WHERE chat_id = $1 AND finished_at IS NULL AND status IN ('pending','submitted')",
      [chat],
    );
  }

  /** Finds a command by its durable submission identity (the bridge's
   *  run_start/run_end carry submission ids). */
  async byInvocation(invocation: string): Promise<TurnCommand[]> {
    const res = await this.pool.query<TurnCommand>(
      "SELECT id, org_id, user_id, chat_id, request, payload, status, invocation_id, position FROM turn_commands WHERE invocation_id = $1",
      [invocation],
    );
    return res.rows;
  }
}

/** serde_json::Value equality: structural, object keys unordered. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEq(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>).sort();
  const kb = Object.keys(b as Record<string, unknown>).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
