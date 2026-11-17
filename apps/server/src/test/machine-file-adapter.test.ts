import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { MachineExecutionEnv, type MachineDispatch, type MachineToolOutcome } from "../machines/dispatch.js";

type Dispatch = Pick<MachineDispatch, "dispatch">;

/** A stand-in engine over a real directory: answers the raw file ops and
 *  `write_file` the way crates/app-server/src/machine_link.rs does. */
function engine(
  dir: string,
  opts: { legacy?: boolean; staged?: Buffer } = {},
): { dispatch: Dispatch; calls: string[] } {
  const staged = opts.staged ?? Buffer.from("staged");
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
            return reply({
              exists: true,
              kind: st.isDirectory() ? "directory" : "file",
              size: st.size,
              mtime_ms: st.mtimeMs,
            });
          } catch {
            return reply({ exists: false });
          }
        case "fs.fetch_v1": {
          // The engine pulls the staged artifact with its own session; the
          // fake stands in for that download.
          writeFileSync(file, staged);
          return reply({ path: file, size: staged.length });
        }
        case "write_file": {
          // As the engine does: `encoding: base64` means the content is bytes.
          const { encoding } = call.args as { encoding?: string };
          const content = args.content ?? "";
          writeFileSync(file, encoding === "base64" ? Buffer.from(content, "base64") : content);
          return reply(`wrote to ${file}`);
        }
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

function env(
  dir: string,
  dispatch: Dispatch,
  stage: (b: Uint8Array, n: string) => Promise<string> = async () => "a-1",
) {
  return new MachineExecutionEnv({
    machineId: "m",
    orgId: "o",
    chatId: "c",
    workdir: dir,
    timeoutMs: 1000,
    dispatch,
    stage,
  });
}

describe("machine file adapter", () => {
  it("stages bytes and lets the machine pull them by id, never over the socket", async () => {
    const dir = scratch();
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const { dispatch, calls } = engine(dir, { staged: bytes });
    const staged: { bytes: number; name: string }[] = [];
    const e = env(dir, dispatch, async (content, name) => {
      staged.push({ bytes: content.length, name });
      return "artifact-1";
    });
    const written = await e.writeFile(path.join(dir, "report.pdf"), new Uint8Array(bytes), BACKGROUND_CONTEXT);
    expect(written.ok).toBe(true);
    // The bytes went to the stager, not into the dispatch frame.
    expect(staged).toEqual([{ bytes: bytes.length, name: path.join(dir, "report.pdf") }]);
    expect(calls).toEqual(["fs.fetch_v1"]);
    expect([...readFileSync(path.join(dir, "report.pdf"))]).toEqual([...bytes]);
  });

  it("refuses bytes to an engine that cannot pull an artifact", async () => {
    const dir = scratch();
    const { dispatch } = engine(dir, { legacy: true });
    const e = env(dir, dispatch);
    const written = await e.writeFile(path.join(dir, "report.pdf"), new Uint8Array([0x25, 0x50]), BACKGROUND_CONTEXT);
    expect(written.ok).toBe(false);
    expect(written.ok ? "" : written.error.message).toContain("update the desktop app");
  });

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
    expect(seen).toEqual([
      { text: "a\r", terminated: true },
      { text: "b", terminated: true },
    ]);
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
