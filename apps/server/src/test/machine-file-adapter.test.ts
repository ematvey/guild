import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { MachineExecutionEnv, type MachineDispatch, type MachineToolOutcome } from "../machines/dispatch.js";

type Dispatch = Pick<MachineDispatch, "dispatch">;

/** A stand-in engine over a real directory: answers the raw file ops and
 *  `write_file` the way crates/app-server/src/machine_link.rs does. */
function engine(dir: string, opts: { legacy?: boolean } = {}): { dispatch: Dispatch; calls: string[] } {
  const calls: string[] = [];
  const reply = (content: unknown, is_error = false): MachineToolOutcome => ({
    content: typeof content === "string" ? content : JSON.stringify(content),
    is_error,
    meta: null,
    images: [],
  });
  const dispatch: Dispatch = {
    async dispatch(call) {
      calls.push(call.name);
      const args = call.args as { path: string; content?: string };
      const file = path.resolve(dir, args.path);
      if (opts.legacy && call.name.startsWith("fs.")) {
        return reply(`invalid input: unknown tool ${call.name}`, true);
      }
      switch (call.name) {
        case "fs.read_raw_v1":
          try {
            const bytes = readFileSync(file);
            return reply({ size: bytes.length, mtime_ms: statSync(file).mtimeMs, data_b64: bytes.toString("base64") });
          } catch {
            return reply({ code: "not_found", message: `${file}: not found` }, true);
          }
        case "fs.stat_v1":
          try {
            const st = statSync(file);
            return reply({ exists: true, kind: st.isDirectory() ? "directory" : "file", size: st.size, mtime_ms: st.mtimeMs });
          } catch {
            return reply({ exists: false });
          }
        case "write_file":
          writeFileSync(file, args.content ?? "");
          return reply(`wrote to ${file}`);
        default:
          return reply(`invalid input: unknown tool ${call.name}`, true);
      }
    },
  };
  return { dispatch, calls };
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-machine-fs-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(dir: string, dispatch: Dispatch): MachineExecutionEnv {
  return new MachineExecutionEnv({ machineId: "m", orgId: "o", chatId: "c", workdir: dir, timeoutMs: 1000, dispatch });
}

describe("machine file adapter", () => {
  it("reads large CRLF text without a trailing newline exactly, and an edit writes it back whole", async () => {
    const dir = scratch();
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} — padded so the file is well past 64 KB`);
    const original = lines.join("\r\n");
    writeFileSync(path.join(dir, "big.txt"), original);
    const { dispatch, calls } = engine(dir);
    const e = env(dir, dispatch);

    const read = await e.readTextFile("big.txt", BACKGROUND_CONTEXT);
    expect(read.ok && read.value).toBe(original);
    expect(calls).toEqual(["fs.read_raw_v1"]);

    // The pi edit tool: readTextFile → replace → writeFile of the whole content.
    const edited = original.replace("line 4999", "LINE 4999");
    expect((await e.writeFile("big.txt", edited, BACKGROUND_CONTEXT)).ok).toBe(true);
    expect(readFileSync(path.join(dir, "big.txt"), "utf8")).toBe(edited);
    expect(readFileSync(path.join(dir, "big.txt")).length).toBe(Buffer.byteLength(original));
  });

  it("keeps binary bytes and refuses to decode non-UTF-8 as text", async () => {
    const dir = scratch();
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x0d, 0x0a]);
    writeFileSync(path.join(dir, "b.bin"), bytes);
    const e = env(dir, engine(dir).dispatch);
    const bin = await e.readBinaryFile("b.bin", BACKGROUND_CONTEXT);
    expect(bin.ok && Array.from(bin.value)).toEqual(Array.from(bytes));
    const text = await e.readTextFile("b.bin", BACKGROUND_CONTEXT);
    expect(!text.ok && text.error.code).toBe("invalid");
  });

  it("stats through fs.stat_v1 and maps absence", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "a.txt"), "abc\n");
    const e = env(dir, engine(dir).dispatch);
    const info = await e.fileInfo("a.txt", BACKGROUND_CONTEXT);
    expect(info.ok && { kind: info.value.kind, size: info.value.size }).toEqual({ kind: "file", size: 4 });
    expect(await e.exists("a.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: true });
    expect(await e.exists("gone.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
    const missing = await e.fileInfo("gone.txt", BACKGROUND_CONTEXT);
    expect(!missing.ok && missing.error.code).toBe("not_found");
    const unread = await e.readTextFile("gone.txt", BACKGROUND_CONTEXT);
    expect(!unread.ok && unread.error.code).toBe("not_found");
  });

  it("a line reader reports the final newline as a terminator, not an extra line", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "t.txt"), "a\r\nb\n");
    const reader = await env(dir, engine(dir).dispatch).openTextLineReader("t.txt", BACKGROUND_CONTEXT);
    if (!reader.ok) throw reader.error;
    const seen = [];
    for (;;) {
      const line = await reader.value.readLine(BACKGROUND_CONTEXT);
      if (!line.ok || line.value === undefined) break;
      seen.push(line.value);
    }
    expect(seen).toEqual([{ text: "a\r", terminated: true }, { text: "b", terminated: true }]);
  });

  it("an engine without the raw ops fails as not_supported instead of reading lossily", async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, "a.txt"), "x");
    const { dispatch, calls } = engine(dir, { legacy: true });
    const e = env(dir, dispatch);
    const read = await e.readTextFile("a.txt", BACKGROUND_CONTEXT);
    expect(!read.ok && read.error.code).toBe("not_supported");
    const exists = await e.exists("a.txt", BACKGROUND_CONTEXT);
    expect(!exists.ok && exists.error.code).toBe("not_supported");
    expect(calls).not.toContain("read_file");
  });
});
