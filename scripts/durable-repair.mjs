// Audit stored document chains. --fix rebuilds only the built-in live
// projection from durable tasks/submissions, retaining the damaged revisions.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { apply } from "@earendil-works/chord/delta";

// The storage adapter is TypeScript and the deployed runtime executes it in Bun.
if (!process.versions.bun) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const pool = new pg.Pool({
  connectionString: process.env.GUILD_DATABASE_URL ?? "postgres://guild:guild@127.0.0.1:5432/guild",
  max: 2,
});
try {
  const docs = await pool.query("SELECT id,kind FROM documents WHERE retired_at IS NULL");
  let bad = 0;
  for (const doc of docs.rows) {
    const baseRows = await pool.query(
      "SELECT seq,version,content FROM document_revisions WHERE document_id=$1 AND kind='base' ORDER BY seq DESC LIMIT 1",
      [doc.id],
    );
    const base = baseRows.rows[0];
    if (!base) continue;
    const tail = await pool.query(
      "SELECT kind,version,content FROM document_revisions WHERE document_id=$1 AND seq>$2 ORDER BY seq",
      [doc.id, base.seq],
    );
    try {
      let value = JSON.parse(base.content);
      for (const revision of tail.rows) {
        if (revision.kind !== "delta" || revision.version !== base.version)
          throw new Error("version boundary without a base");
        value = apply(value, JSON.parse(revision.content));
      }
    } catch (error) {
      bad++;
      console.log(`document ${doc.id} kind=${doc.kind}: ${String(error)}`);
    }
  }
  console.log(`scanned ${docs.rows.length} current documents; invalid: ${bad}`);
  if (process.argv.includes("--fix")) {
    const { PostgresDurableStorage } = await import("../apps/server/src/storage/postgres/storage.ts");
    const { SharedPoolDatabase } = await import("../apps/server/src/storage/postgres/pg.ts");
    const storage = await PostgresDurableStorage.open(new SharedPoolDatabase(pool));
    const repaired = await storage.repairLiveProjections();
    console.log(`rebuilt live projections: ${repaired.join(", ") || "none"}; other document kinds are unchanged`);
  }
} finally {
  await pool.end();
}
