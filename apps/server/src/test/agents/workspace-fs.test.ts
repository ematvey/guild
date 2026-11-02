// Server-side workspace file access refuses what a hostile sandbox can
// plant on the shared volume: symlinked files and directories, devices,
// FIFOs and oversized files. Normal files still read and write.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceFile, writeWorkspaceFile, WorkspaceFsError } from "../../agents/workspace-fs.js";
import { CONFIG_MAX_BYTES, readAgentConfig, seedAgentWorkspace } from "../../agents/workspace-config.js";

const dirs: string[] = [];
function scratch(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "guild-workspace-fs-"));
  dirs.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "MASTER_KEY=hunter2\n");
  return { root, outside };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof WorkspaceFsError) return error.reason;
    throw error;
  }
};

describe("readWorkspaceFile", () => {
  it("reads a regular file", async () => {
    const { root } = scratch();
    mkdirSync(path.join(root, "notes"));
    writeFileSync(path.join(root, "notes", "a.md"), "hello");
    const read = await readWorkspaceFile(root, "notes/a.md", { maxBytes: 1024, overflow: "refuse" });
    expect(read.bytes.toString("utf8")).toBe("hello");
    expect(read.truncated).toBe(false);
  });

  it("refuses a symlinked final segment", async () => {
    const { root, outside } = scratch();
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"));
    expect(await reasonOf(readWorkspaceFile(root, "AGENTS.md", { maxBytes: 1024, overflow: "refuse" }))).toBe(
      "symlink",
    );
  });

  it("refuses a symlinked directory segment", async () => {
    const { root, outside } = scratch();
    symlinkSync(outside, path.join(root, "notes"));
    expect(await reasonOf(readWorkspaceFile(root, "notes/secret.txt", { maxBytes: 1024, overflow: "refuse" }))).toBe(
      "symlink",
    );
  });

  it("refuses a hard path escape and a device", async () => {
    const { root } = scratch();
    expect(
      await reasonOf(readWorkspaceFile(root, "../outside/secret.txt", { maxBytes: 1024, overflow: "refuse" })),
    ).toBe("bad_path");
    symlinkSync("/dev/zero", path.join(root, "zero"));
    expect(await reasonOf(readWorkspaceFile(root, "zero", { maxBytes: 1024, overflow: "refuse" }))).toBe("symlink");
  });

  it("refuses a FIFO without blocking", async () => {
    const { root } = scratch();
    const fifo = path.join(root, "AGENTS.md");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return;
    }
    expect(await reasonOf(readWorkspaceFile(root, "AGENTS.md", { maxBytes: 1024, overflow: "refuse" }))).toBe(
      "not_file",
    );
  });

  it("caps a huge sparse file: refused or truncated to its head", async () => {
    const { root } = scratch();
    const big = path.join(root, "big.md");
    writeFileSync(big, "head");
    truncateSync(big, 8 * 1024 * 1024 * 1024);
    expect(await reasonOf(readWorkspaceFile(root, "big.md", { maxBytes: 1024, overflow: "refuse" }))).toBe("too_large");
    const head = await readWorkspaceFile(root, "big.md", { maxBytes: 16, overflow: "truncate" });
    expect(head.truncated).toBe(true);
    expect(head.bytes.length).toBe(16);
    expect(head.bytes.subarray(0, 4).toString("utf8")).toBe("head");
  });
});

describe("writeWorkspaceFile", () => {
  it("writes and overwrites a regular file, creating parents", async () => {
    const { root } = scratch();
    expect(await writeWorkspaceFile(root, "notes/README.md", "one")).toBe(true);
    expect(await writeWorkspaceFile(root, "notes/README.md", "two words")).toBe(true);
    expect(readFileSync(path.join(root, "notes", "README.md"), "utf8")).toBe("two words");
    expect(await writeWorkspaceFile(root, "notes/README.md", "three", { exclusive: true })).toBe(false);
    expect(readFileSync(path.join(root, "notes", "README.md"), "utf8")).toBe("two words");
  });

  it("refuses to write through a symlinked file or directory", async () => {
    const { root, outside } = scratch();
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"));
    expect(await reasonOf(writeWorkspaceFile(root, "AGENTS.md", "pwned"))).toBe("symlink");
    symlinkSync(outside, path.join(root, "notes"));
    expect(await reasonOf(writeWorkspaceFile(root, "notes/README.md", "pwned"))).toBe("symlink");
    expect(existsSync(path.join(outside, "README.md"))).toBe(false);
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("MASTER_KEY=hunter2\n");
  });
});

describe("agent config through workspace-fs", () => {
  it("ignores a symlinked AGENTS.md instead of reading its target", async () => {
    const { root, outside } = scratch();
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"));
    symlinkSync("/proc/self/environ", path.join(root, "MEMORY.md"));
    expect(await seedAgentWorkspace(root)).toEqual([]);
    const config = await readAgentConfig(root);
    expect(config.files.size).toBe(0);
    expect(config.missing).toEqual(["AGENTS.md"]);
  });

  it("caps an oversized config file with a truncation marker", async () => {
    const { root } = scratch();
    writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(CONFIG_MAX_BYTES + 100));
    const text = (await readAgentConfig(root)).files.get("AGENTS.md")!;
    expect(text.startsWith("x".repeat(CONFIG_MAX_BYTES))).toBe(true);
    expect(text).toContain(`(truncated at ${CONFIG_MAX_BYTES} bytes`);
  });
});
