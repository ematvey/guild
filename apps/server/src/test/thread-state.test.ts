// Byte-fidelity of the ThreadState surface against the LIVE Rust member
// socket: frames captured from the running :18080 stack (disposable chat +
// one real GLM-5.3-Flash turn; see M3-REPORT.md §SSE fixtures). The Rust
// server serializes ThreadEventRow through serde_json Values (BTreeMap,
// sorted keys at every level) and the ThreadState enum itself in variant
// declaration order — these tests pin both, from real bytes.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeThreadEvent, threadEventRowWire } from "../platform/domain/thread-events.js";
import { threadStateWire } from "../chats/thread-state.js";

const FINAL_FRAME = readFileSync(new URL("./fixtures/m3-live/final-thread-state.txt", import.meta.url), "utf8").trim();

interface ParsedRow {
  id: string;
  chat_id: string;
  seq: number;
  event: Record<string, unknown>;
  created_at: string;
}
interface ParsedFrame {
  type: string;
  chat_id: string;
  seq: number;
  events: ParsedRow[];
  text: string;
  thinking: string;
  generating: boolean;
  has_more_events: boolean;
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
}

/** Extracts the raw row substrings from the frame's events array (balanced
 *  brace walk — JSON.parse would lose the ryu float shapes). */
function rawRows(frame: string): string[] {
  const start = frame.indexOf('"events":[') + '"events":['.length;
  const end = frame.indexOf('],"text":');
  const body = frame.slice(start, end);
  const rows: string[] = [];
  let depth = 0;
  let rowStart = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        rows.push(body.slice(rowStart, i + 1));
        rowStart = i + 2; // skip the comma
      }
    }
  }
  return rows;
}

const FRAME = parseFrame(FINAL_FRAME);
const RAW_ROW_TEXTS = rawRows(FINAL_FRAME);

function parseFrame(frame: string): ParsedFrame {
  const json = frame.startsWith("data: ") ? frame.slice("data: ".length) : frame;
  return JSON.parse(json) as ParsedFrame;
}

describe("ThreadState wire fidelity (live Rust bytes)", () => {
  it("re-renders every captured event row byte-identically", () => {
    expect(FRAME.type).toBe("thread_state");
    expect(FRAME.events.length).toBe(RAW_ROW_TEXTS.length);
    for (const [index, row] of FRAME.events.entries()) {
      const event = normalizeThreadEvent(row.event);
      expect(event).toBeDefined();
      const rendered = threadEventRowWire({
        id: row.id,
        chat_id: row.chat_id,
        seq: row.seq,
        event: event!,
        created_at: row.created_at,
      });
      // Byte-for-byte against what the Rust member socket actually sent
      // (raw slice — a JSON round-trip would lose the ryu float shapes).
      expect(rendered).toBe(RAW_ROW_TEXTS[index]!);
    }
  });

  it("rebuilds the whole ThreadState frame byte-identically", () => {
    const events = FRAME.events.map((row) => ({
      id: row.id,
      chat_id: row.chat_id,
      seq: row.seq,
      event: normalizeThreadEvent(row.event)!,
      created_at: row.created_at,
    }));
    const capture = {
      chatId: FRAME.chat_id,
      seq: FRAME.seq,
      events,
      text: FRAME.text,
      thinking: FRAME.thinking,
      generating: FRAME.generating,
      projectId: FRAME.project_id,
      projectName: FRAME.project_name,
      projectMachineLabel: FRAME.project_machine_label,
      hasMoreEvents: FRAME.has_more_events,
    };
    expect(threadStateWire(capture)).toBe(FINAL_FRAME);
  });

  it("the REST GET /thread body carries the same rows (semantic)", () => {
    const thread = JSON.parse(readFileSync(new URL("./fixtures/m3-live/thread.json", import.meta.url), "utf8")) as {
      context: { max: number; model: string | null; tokens: number };
      events: ParsedRow[];
    };
    const frame = parseFrame(FINAL_FRAME);
    // Same chat, same rows.
    expect(thread.events.map((r) => r.id)).toEqual(frame.events.map((r) => r.id));
    // Context gauge: tokens from the latest assistant turn's tokens_in.
    const lastAssistant = [...thread.events].reverse().find((r) => r.event.type === "assistant_message");
    expect(thread.context.tokens).toBe((lastAssistant!.event.usage as { tokens_in: number }).tokens_in);
    expect(thread.context.model).toBe((lastAssistant!.event as { model: string }).model);
    expect(thread.context.max).toBeGreaterThan(0);
  });

  it("frames place the tag first and sort row keys (declaration vs Value order)", () => {
    // Tag first — the enum is serialized directly, not through a Value.
    expect(FINAL_FRAME.startsWith('{"type":"thread_state","chat_id":')).toBe(true);
    // Rows are Values: sorted keys.
    expect(FINAL_FRAME).toContain('{"chat_id":');
    expect(FINAL_FRAME).not.toContain('{"id":');
  });
});
