// Property-style check of the one event fold: for generated event logs
// covering every event type, deriving the whole log and folding it
// incrementally through the reducer give the same blocks (keys included),
// and every key is unique.

import { describe, expect, it } from "vitest";
import { createThreadReducer, deriveThread, eventsToBlocks, foldEvent, type ThreadFold } from "./thread-reducer";
import type { ThreadEvent, ThreadEventRow, ThreadState } from "./thread-events";

const usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
const file = (id: string) => ({ id, filename: `${id}.txt`, content_type: "text/plain", size_bytes: 3, modality: "document" });

/** Deterministic PRNG (mulberry32): a failing seed reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random but well-formed log: results and decisions name earlier calls,
 *  closes and results name earlier spawns, a delivered queued send re-emits
 *  its row id at a later seq. */
function genLog(seed: number, len: number): ThreadEventRow[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(r() * xs.length)];
  const calls: string[] = [];
  const approvals: string[] = [];
  const threads: string[] = [];
  const queuedIds: string[] = [];
  const rows: ThreadEventRow[] = [];
  for (let seq = 1; seq <= len; seq++) {
    let id = `e${seq}`;
    let event: ThreadEvent;
    switch (Math.floor(r() * 11)) {
      case 0: {
        const redeliver = r() < 0.5 ? queuedIds.shift() : undefined;
        const queued = !redeliver && r() < 0.3;
        if (redeliver) id = redeliver;
        if (queued) queuedIds.push(id);
        event = {
          type: "user_message",
          content: r() < 0.3 ? "see\n\n[Attachment: a.txt]" : `hi ${seq}`,
          attachments: r() < 0.3 ? [file(`u${seq}`)] : [],
          ...(queued ? { queued: true, mode: r() < 0.5 ? "steer" : "queue" } : {}),
        };
        break;
      }
      case 1:
        event = { type: "system_message", content: "sys" };
        break;
      case 2: {
        const blocks: Extract<ThreadEvent, { type: "assistant_message" }>["blocks"] = [];
        const n = Math.floor(r() * 4);
        for (let i = 0; i < n; i++) {
          const k = r();
          if (k < 0.3) blocks.push({ type: "reasoning", text: `think ${seq}.${i}` });
          else if (k < 0.65) blocks.push({ type: "text", text: `say ${seq}.${i}` });
          else {
            const call = `c${seq}.${i}`;
            calls.push(call);
            blocks.push({ type: "tool_call", id: call, name: r() < 0.5 ? "read_file" : "web_search", arguments: "{}" });
          }
        }
        event = {
          type: "assistant_message",
          turn: 1,
          step: seq,
          model: "m",
          usage,
          blocks,
          ...(r() < 0.3 ? { error: `boom ${seq}` } : {}),
          ...(r() < 0.3 ? { attachments: [file(`a${seq}`)] } : {}),
          ...(r() < 0.2 ? { interrupted: true } : {}),
        } as ThreadEvent;
        break;
      }
      case 3:
        event = {
          type: "tool_result",
          turn: 1,
          step: seq,
          call_id: (r() < 0.8 ? pick(calls) : undefined) ?? `orphan${seq}`,
          name: "read_file",
          content: `out ${seq}`,
          is_error: r() < 0.3,
        };
        break;
      case 4:
        event = { type: "compaction", summary: `sum ${seq}`, keep_last: 2 };
        break;
      case 5: {
        const call = (r() < 0.2 ? pick(approvals) : undefined) ?? `ap${seq}`;
        approvals.push(call);
        event = { type: "approval_request", call_id: call, name: "execute", arguments: "{}" };
        break;
      }
      case 6:
        event = {
          type: "approval_decision",
          call_id: pick(approvals) ?? "none",
          approved: r() < 0.5,
          ...(r() < 0.4 ? { expired: true, reason: "turn ended" } : {}),
        };
        break;
      case 7:
        event = { type: "turn_error", message: `fail ${seq}` };
        break;
      case 8: {
        const t = `t${seq}`;
        threads.push(t);
        event = {
          type: "child_spawned",
          thread_id: t,
          run_id: "r",
          chat_id: `chat-${t}`,
          agent_name: "Helper",
          title: "job",
          status: "running",
          task: "do it",
        };
        break;
      }
      case 9:
        event = {
          type: "child_result",
          thread_id: pick(threads) ?? "t-missing",
          run_id: "r",
          chat_id: "",
          agent_name: "",
          title: "",
          status: "completed",
          final_text: "done",
          attachments: [],
        } as unknown as ThreadEvent;
        break;
      default:
        event = { type: "child_closed", thread_id: pick(threads) ?? "t-missing" };
    }
    rows.push({ id, chat_id: "c1", seq, event, created_at: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` });
  }
  return rows;
}

function state(seq: number, events: ThreadEventRow[]): ThreadState {
  return { type: "thread_state", has_more_events: false, chat_id: "c1", seq, events, text: "", thinking: "", generating: false };
}

/** The log as the server holds it: a re-emitted row id replaces its older seq. */
function latestRows(rows: ThreadEventRow[]): ThreadEventRow[] {
  const byId = new Map<string, ThreadEventRow>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

describe("foldEvent: incremental == full derivation", () => {
  const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

  it("covers every event type across the generated logs", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) for (const row of genLog(seed, 20)) seen.add(row.event.type);
    expect(seen.size).toBe(11);
  });

  it("folding row by row equals deriving at every prefix; keys are unique", () => {
    for (const seed of SEEDS) {
      const rows = genLog(seed, 20);
      const acc: ThreadFold = { blocks: [], toolsByCall: new Map(), approvalsByCall: new Map() };
      rows.forEach((row, i) => {
        foldEvent(acc, row);
        const derived = deriveThread(rows.slice(0, i + 1));
        expect(acc.blocks, `seed ${seed} step ${i}`).toEqual(derived.blocks);
        const keys = acc.blocks.map((b) => b.key);
        expect(new Set(keys).size, `seed ${seed} step ${i}: ${keys.join(",")}`).toBe(keys.length);
        // Only the last block may be an error.
        expect(acc.blocks.slice(0, -1).some((b) => b.kind === "error")).toBe(false);
      });
    }
  });

  it("a sync of any prefix plus live fan-out equals a sync of the whole log", () => {
    for (const seed of SEEDS) {
      const rows = genLog(seed, 16);
      const whole = eventsToBlocks(rows);
      for (let k = 0; k <= rows.length; k++) {
        const r = createThreadReducer();
        r.open("c1");
        // A sync carries the log as the server holds it at that seq.
        r.applyState(state(k, latestRows(rows.slice(0, k))));
        let last = r.view("c1");
        for (const row of rows.slice(k)) last = r.applyThreadEvents("c1", row.seq, [row]);
        expect(last.blocks, `seed ${seed} split ${k}`).toEqual(whole);
      }
    }
  });

  it("an error with attachments and no text keeps its key apart and stays last", () => {
    const rows: ThreadEventRow[] = [
      { id: "u", chat_id: "c1", seq: 1, created_at: "t", event: { type: "user_message", content: "go", attachments: [] } },
      {
        id: "a",
        chat_id: "c1",
        seq: 2,
        created_at: "t",
        event: { type: "assistant_message", turn: 1, step: 0, model: "m", usage, blocks: [], error: "boom", attachments: [file("f")] },
      },
    ];
    const blocks = eventsToBlocks(rows);
    expect(blocks.map((b) => [b.kind, b.key])).toEqual([["user", "1:0"], ["text", "2:0"], ["error", "2:1"]]);
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state(1, rows.slice(0, 1)));
    expect(r.applyThreadEvents("c1", 2, rows.slice(1)).blocks).toEqual(blocks);
  });
});
