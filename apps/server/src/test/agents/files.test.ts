// Read-only file browser: relative-path validation, hidden entries,
// symlink opacity and the size limits.

import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentFiles, normalizeRelativePath } from "../../agents/files.js";

let root: string;
let files: AgentFiles;
const orgId = "11111111-1111-7111-8111-111111111111";
const agentId = "22222222-2222-7222-8222-222222222222";

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "guild-agent-files-"));
  const agentRoot = path.join(root, "agents", orgId, agentId);
  await mkdir(path.join(agentRoot, "docs"), { recursive: true });
  await mkdir(path.join(agentRoot, ".guild"), { recursive: true });
  await mkdir(path.join(agentRoot, "node_modules"), { recursive: true });
  await writeFile(path.join(agentRoot, "hello.txt"), "hello agent\n");
  await writeFile(path.join(agentRoot, "docs", "note.md"), "# note\n");
  await writeFile(path.join(agentRoot, ".guild", "state.json"), "{}");
  await writeFile(path.join(agentRoot, "node_modules", "pkg.js"), "module.exports = 1;\n");
  await writeFile(path.join(agentRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(path.join(agentRoot, "large.txt"), "");
  await truncate(path.join(agentRoot, "large.txt"), 1024 * 1024 + 1);
  await writeFile(path.join(agentRoot, "huge.txt"), "");
  await truncate(path.join(agentRoot, "huge.txt"), 64 * 1024 * 1024 + 1);
  await symlink(path.join(agentRoot, "docs"), path.join(agentRoot, "docs-link"));
  await symlink("/etc", path.join(agentRoot, "outside-link"));
  files = new AgentFiles(root);
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("normalizeRelativePath", () => {
  it("accepts relative paths and rejects escapes", () => {
    expect(normalizeRelativePath(undefined)).toBe("");
    expect(normalizeRelativePath("./docs//note.md")).toBe("docs/note.md");
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(/absolute/);
    expect(() => normalizeRelativePath("C:\\Windows")).toThrow(/absolute/);
    expect(() => normalizeRelativePath("../secret")).toThrow(/parent traversal/);
    expect(() => normalizeRelativePath("docs/../../secret")).toThrow(/parent traversal/);
    expect(() => normalizeRelativePath("a\u0000b")).toThrow(/NUL/);
  });
});

describe("AgentFiles", () => {
  it("lists a directory and hides internal folders by default", async () => {
    const listing = await files.listDir(orgId, agentId);
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain("hello.txt");
    expect(names).toContain("docs");
    expect(names).not.toContain(".guild");
    expect(names).not.toContain("node_modules");
    const symlinkEntry = listing.entries.find((entry) => entry.name === "docs-link");
    expect(symlinkEntry).toMatchObject({ symlink: true, kind: "other" });

    const shown = await files.listDir(orgId, agentId, undefined, true);
    expect(shown.entries.map((entry) => entry.name)).toContain(".guild");
  });

  it("lists the parent folder when the path names a file", async () => {
    const listing = await files.listDir(orgId, agentId, "docs/note.md");
    expect(listing.path).toBe("docs");
    expect(listing.file).toBe("docs/note.md");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["note.md"]);

    const rootListing = await files.listDir(orgId, agentId, "hello.txt");
    expect(rootListing.path).toBe("");
    expect(rootListing.file).toBe("hello.txt");
    expect(rootListing.entries.map((entry) => entry.name)).toContain("hello.txt");
  });

  it("stats files and symlinks without following the link", async () => {
    const file = await files.statPath(orgId, agentId, "hello.txt");
    expect(file).toMatchObject({ kind: "file", size: 12, symlink: false });
    const link = await files.statPath(orgId, agentId, "outside-link");
    expect(link).toMatchObject({ symlink: true, kind: "other" });
  });

  it("reads text and refuses binary or oversized files", async () => {
    expect((await files.readText(orgId, agentId, "hello.txt")).text).toBe("hello agent\n");
    await expect(files.readText(orgId, agentId, "binary.bin")).rejects.toMatchObject({ status: 400 });
    await expect(files.readText(orgId, agentId, "large.txt")).rejects.toMatchObject({ status: 400 });
    await expect(files.readText(orgId, agentId, "docs")).rejects.toMatchObject({ status: 400 });
  });

  it("never descends or reads through symlinks", async () => {
    await expect(files.listDir(orgId, agentId, "docs-link")).rejects.toMatchObject({ status: 400 });
    await expect(files.readText(orgId, agentId, "outside-link/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(files.streamDownload(orgId, agentId, "docs-link/note.md")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects traversal and missing paths", async () => {
    await expect(files.readText(orgId, agentId, "../secret.txt")).rejects.toMatchObject({ status: 400 });
    await expect(files.listDir(orgId, agentId, "/etc")).rejects.toMatchObject({ status: 400 });
    await expect(files.readText(orgId, agentId, "missing.txt")).rejects.toMatchObject({ status: 404 });
    // An untouched agent has no directory yet: the browser shows an empty
    // workspace, and the route's access check rejects an unknown agent.
    await expect(files.listDir("33333333-3333-7333-8333-333333333333", agentId)).resolves.toEqual({
      path: "",
      entries: [],
    });
  });

  it("streams downloads and enforces the 64 MiB cap", async () => {
    const download = await files.streamDownload(orgId, agentId, "hello.txt");
    expect(download.name).toBe("hello.txt");
    expect(download.size).toBe(12);
    expect((await readStream(download.stream)).toString("utf8")).toBe("hello agent\n");
    await expect(files.streamDownload(orgId, agentId, "huge.txt")).rejects.toMatchObject({ status: 400 });
  });
});
