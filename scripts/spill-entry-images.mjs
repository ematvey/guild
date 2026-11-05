// Move stored image blobs out of the database.
//
// Before media references existed, a tool result's images were base64 in
// `entries.record` (the durable log) and in `thread_events.payload` (the
// derived socket copy). This walks every entry that still carries image
// bytes, stores them as tool artifacts, and rewrites the entry with the
// reference. Then it rewrites the thread events of the same chats so the
// socket copy names the references too.
//
// Idempotent: an entry or event that already names references is skipped, and
// the artifact ids are deterministic (uuid v5 over chat id and call id), so a
// rerun re-derives the same rows.
//
//   bun scripts/spill-entry-images.mjs --database-url postgres://… [--dry-run]
//
// Needs the same S3 settings as the server (GUILD_S3_*), because the bytes
// move into that bucket.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (!process.versions.bun) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? "");
};
const dryRun = args.includes("--dry-run");
const databaseUrl =
  flag("--database-url") ?? process.env.GUILD_DATABASE_URL ?? "postgres://guild:guild@127.0.0.1:5432/guild";

const { ObjectStore } = await import("../apps/server/src/platform/s3.ts");
const { ToolArtifactStore } = await import("../apps/server/src/platform/store/tool-artifacts.ts");
const { spillImageParts } = await import("../apps/server/src/chats/media-spill.ts");
const { isImagePart, mediaRefOf, parseMediaRef } = await import("../apps/server/src/platform/media-ref.ts");
const { artifactUuid } = await import("../apps/server/src/platform/store/tool-artifacts.ts");

const objects = new ObjectStore({
  s3Url: process.env.GUILD_S3_URL ?? "http://127.0.0.1:9000",
  s3Bucket: process.env.GUILD_S3_BUCKET ?? "guild",
  s3AccessKeyId: process.env.GUILD_S3_ACCESS_KEY_ID ?? "guild",
  s3SecretAccessKey: process.env.GUILD_S3_SECRET_ACCESS_KEY ?? "guild",
});
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const artifacts = new ToolArtifactStore(pool);

let movedEntries = 0;
let movedImages = 0;
let movedEvents = 0;
let droppedImages = 0;
/** chat + call → the references its event's images now name. */
const refsByCall = new Map();
try {
  const rows = await pool.query(
    `SELECT e.id, e.record, cc.chat_id, c.org_id
       FROM entries e
       JOIN chat_conversations cc ON cc.conversation_id = e.conversation_id
       JOIN chats c ON c.id = cc.chat_id
      WHERE e.record LIKE '%"type":"image"%'
      ORDER BY e.id`,
  );
  for (const row of rows.rows) {
    const record = JSON.parse(row.record);
    let changed = false;
    for (const message of record.model ?? []) {
      if (!Array.isArray(message.content)) continue;
      const parts = message.content;
      if (!parts.some((part) => isImagePart(part) && parseMediaRef(part.data) === null)) continue;
      const spilled = await spillImageParts(
        { artifacts, objects },
        {
          orgId: row.org_id,
          chatId: row.chat_id,
          // A tool result names its call; any other entry (a member message
          // with attachments) names the entry, so the ids stay deterministic.
          callId: message.toolCallId ?? `entry-${row.id}`,
          toolName: message.toolName ?? "member",
        },
        parts,
      );
      if (spilled.spilled.length === 0) continue;
      message.content = spilled.parts;
      if (message.toolCallId !== undefined) {
        refsByCall.set(`${row.chat_id}:${message.toolCallId}`, spilled.parts.filter(isImagePart).map((part) => part.data));
      }
      movedImages += spilled.spilled.length;
      changed = true;
    }
    if (!changed) continue;
    movedEntries += 1;
    if (dryRun) continue;
    await pool.query("UPDATE entries SET record = $2 WHERE id = $1", [row.id, JSON.stringify(record)]);
  }

  const events = await pool.query(
    `SELECT e.id, e.chat_id, e.payload, c.org_id
       FROM thread_events e JOIN chats c ON c.id = e.chat_id
      WHERE e.type = 'tool_result'
        AND jsonb_typeof(e.payload->'images') = 'array'
        AND jsonb_array_length(e.payload->'images') > 0
      ORDER BY e.id`,
  );
  for (const row of events.rows) {
    const payload = row.payload;
    const images = payload.images;
    if (images.every((uri) => parseMediaRef(uri) !== null)) continue;
    // The event is the socket copy of its entry: the entry's references are
    // what it names now. An event whose entry no longer exists keeps none of
    // its bytes — nothing can read them back.
    const refs = refsByCall.get(`${row.chat_id}:${payload.call_id}`);
    if (refs === undefined) {
      droppedImages += images.length;
      delete payload.images;
    } else {
      payload.images = refs.map((ref) => `data:image/png;base64,${ref}`);
    }
    movedEvents += 1;
    if (dryRun) continue;
    await pool.query("UPDATE thread_events SET payload = $2 WHERE id = $1", [row.id, JSON.stringify(payload)]);
  }
  console.log(
    `${dryRun ? "[dry run] " : ""}entries ${movedEntries} (images ${movedImages}), ` +
      `events ${movedEvents} (dropped ${droppedImages} orphaned images)`,
  );
} finally {
  await pool.end();
  objects.destroy();
}
