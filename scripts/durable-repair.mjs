// Finds durable documents whose stored deltas no longer materialize, then
// (with --fix) deletes the ephemeral poisoned ones (pi.live family) so the
// next read rematerializes them at their initial value.
import pg from "pg";

const { apply } = await import("/home/user/guild/node_modules/@earendil-works/chord/dist/delta/index.js");

const pool = new pg.Pool({ connectionString: "postgres://guild:guild@127.0.0.1:5432/guild", max: 2 });
const fix = process.argv.includes("--fix");

const docs = await pool.query("SELECT id, kind, record FROM documents");
const bad = [];
for (const doc of docs.rows) {
  const baseRows = await pool.query(
    "SELECT seq, version, content FROM document_revisions WHERE document_id = $1 AND kind = 'base' ORDER BY seq DESC LIMIT 1",
    [doc.id],
  );
  if (baseRows.rows.length === 0) continue;
  const base = baseRows.rows[0];
  const tail = await pool.query(
    "SELECT seq, kind, version, content FROM document_revisions WHERE document_id = $1 AND seq > $2 ORDER BY seq",
    [doc.id, base.seq],
  );
  let value;
  try {
    value = JSON.parse(base.content);
    for (const rev of tail.rows) {
      if (rev.kind !== "delta" || rev.version !== base.version) {
        throw new Error(`version boundary crossed (rev kind=${rev.kind} v=${rev.version} base v=${base.version})`);
      }
      value = apply(value, JSON.parse(rev.content));
    }
  } catch (error) {
    bad.push({ id: doc.id, kind: doc.kind, record: doc.record, error: String(error) });
  }
}

console.log(`scanned ${docs.rows.length} documents, poisoned: ${bad.length}`);
for (const b of bad) {
  console.log(`  doc ${b.id} kind=${b.kind}: ${b.error}`);
  console.log(`    record: ${b.record.slice(0, 200)}`);
}

if (fix) {
  const ephemeral = bad.filter((b) => b.kind.includes("pi.live") || b.kind.includes("pi.inbox") || b.kind.includes("pi.codemode") || b.kind.includes("pi.tool.nested-call"));
  const keep = bad.filter((b) => !ephemeral.includes(b));
  if (keep.length > 0) {
    console.log(`NOT deleting ${keep.length} non-ephemeral poisoned docs (manual review needed):`);
    for (const k of keep) console.log(`  doc ${k.id} kind=${k.kind}`);
  }
  for (const b of ephemeral) {
    await pool.query("DELETE FROM document_revisions WHERE document_id = $1", [b.id]);
    await pool.query("DELETE FROM documents WHERE id = $1", [b.id]);
    console.log(`deleted poisoned ephemeral doc ${b.id} (${b.kind})`);
  }
}
await pool.end();
