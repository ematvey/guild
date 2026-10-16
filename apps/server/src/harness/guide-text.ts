import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

/** Extracts SKILL.md (falling back to README.md) from a tar.gz bundle. */
export async function readGuideText(bundle: Buffer): Promise<string | null> {
  const digest = createHash("sha256").update(bundle).digest("hex");
  if (guideTextCache.has(digest)) return guideTextCache.get(digest)!;
  if (bundle.length > 16 * 1024 * 1024) throw new Error("guide archive exceeds size limit");
  const text = await new Promise<string | null>((resolve, reject) => {
    const found = new Map<string, string>();
    const parser = tar.t({
      strict: true,
      onReadEntry: (entry) => {
        const name = entry.path.replace(/^\.\//, "");
        if (name !== "SKILL.md" && name !== "README.md") {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        entry.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            parser.abort(new Error("guide text exceeds size limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        entry.on("end", () => found.set(name, Buffer.concat(chunks).toString("utf8")));
      },
    });
    parser.on("error", reject);
    parser.on("end", () => {
      const skill = found.get("SKILL.md"),
        readme = found.get("README.md");
      resolve(skill?.trim() ? skill : readme?.trim() ? readme : null);
    });
    let expanded = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        expanded += chunk.length;
        callback(expanded > 32 * 1024 * 1024 ? new Error("expanded guide archive exceeds size limit") : null, chunk);
      },
    });
    void pipeline(Readable.from([bundle]), createGunzip(), limit, parser).catch(reject);
  });
  if (guideTextCache.size >= 64) guideTextCache.delete(guideTextCache.keys().next().value!);
  guideTextCache.set(digest, text);
  return text;
}

const guideTextCache = new Map<string, string | null>();
