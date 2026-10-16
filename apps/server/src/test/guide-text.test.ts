import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { describe, it, expect } from "vitest";
import { readGuideText } from "../harness/guide-text.js";
async function archive(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "guild-guide-test-"));
  try {
    for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
    const chunks: Buffer[] = [];
    for await (const chunk of tar.c({ cwd: dir, gzip: true }, Object.keys(files))) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("bounded guide reading", () => {
  it("reads only root guide text and reuses the immutable digest result", async () => {
    const bytes = await archive({ "SKILL.md": "# Guide\n", "README.md": "fallback", "unused.bin": "ignored" });
    expect(await readGuideText(bytes)).toBe("# Guide\n");
    expect(await readGuideText(bytes)).toBe("# Guide\n");
  });
  it("uses README when SKILL is blank", async () => {
    expect(await readGuideText(await archive({ "SKILL.md": " \n", "README.md": "fallback" }))).toBe("fallback");
  });
  it("rejects a decompressed guide exceeding its text budget", async () => {
    await expect(readGuideText(await archive({ "SKILL.md": "x".repeat(1024 * 1024 + 1) }))).rejects.toThrow(
      "guide text exceeds size limit",
    );
  });
  it("rejects excessive expansion even in unrelated entries", async () => {
    await expect(readGuideText(await archive({ "unused.bin": "x".repeat(33 * 1024 * 1024) }))).rejects.toThrow(
      "expanded guide archive exceeds size limit",
    );
  });
});
