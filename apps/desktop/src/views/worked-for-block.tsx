import { memo, useEffect, useState } from "react";
import { formatDuration } from "../lib/format";
import { Frame } from "./frame";
import type { RenderBlock } from "../lib/thread-reducer";

export type ViewEntry =
  | { kind: "plain"; b: RenderBlock; i: number }
  | { kind: "work"; run: RenderBlock[]; turnStart?: string };

/// Transcript entries. Each CONTIGUOUS agent-work run — thinking, tool
/// calls, subagent lifecycle records and the agent's own intermediate
/// messages — collapses into one work entry; every other block stays 1:1.
/// The pending run is flushed when a non-run block arrives, so a work entry
/// sits where its run was and never trails the text that followed it.
///
/// A turn's own messages fold into the run only once the turn is settled.
/// While the turn runs, every message stays in the transcript as it arrives;
/// when it ends, all but the turn's final message move under the worked-for
/// row. A posted message — a Routine's `send_message`, an agent's message to
/// another thread — belongs to no turn: it stays where it landed.
///
/// The live "Agent is working Ns" clock anchors to the TURN's user message,
/// not the run's own open-time: the turn is what the user is waiting on, so
/// the counter starts at 0 when the agent begins and never resets between
/// steps (per-run open-times are polluted anyway — a state publish carrying
/// the next step's buffer can arrive before the previous step's commit,
/// making the new live block inherit the old open-time). Settled runs keep
/// their own per-run duration.
export function viewEntries(blocks: RenderBlock[], busy = false): ViewEntry[] {
  const entries: ViewEntry[] = [];
  let run: RenderBlock[] = [];
  let turnStart: string | undefined;
  const flush = () => {
    if (run.length) entries.push({ kind: "work", run, turnStart });
    run = [];
  };
  // Committed assistant blocks carry the server's Turn identity. User
  // messages only anchor buffers without one; a steer can share a Turn,
  // and a child result can start one without a user message.
  const turns: string[] = [];
  let turn = -1;
  let current = "input:-1";
  blocks.forEach((b) => {
    if (b.kind === "user" && !b.queued) current = `input:${++turn}`;
    if (b.turn !== undefined && !b.posted) current = `turn:${b.turn}`;
    turns.push(current);
  });
  // The last turn message with a body: the one a settled turn keeps in the
  // transcript. A posted message is never that message — it is not a step
  // of the turn.
  const finalText = new Map<string, number>();
  blocks.forEach((b, i) => {
    if (b.kind === "text" && !b.posted && hasBody(b)) finalText.set(turns[i]!, i);
  });
  const lastTurn = turns[turns.length - 1];
  blocks.forEach((b, i) => {
    const t = turns[i]!;
    if (b.kind === "user" && !b.queued) turnStart = b.ts;
    // A queued send is a chip above the composer, not a transcript entry:
    // it never opens a turn and never breaks the run it sits in.
    if (b.kind === "user" && b.queued) return;
    // The open turn shows every message as it arrives; a settled turn keeps
    // only its last message and folds the earlier ones into the run.
    const settled = t !== lastTurn || !busy;
    const folds = settled && b.kind === "text" && !b.posted && finalText.get(t) !== i;
    if (isWorkBlock(b) || folds) {
      run.push(b);
      return;
    }
    flush();
    entries.push({ kind: "plain", b, i });
  });
  flush();
  return entries;
}

/** A message that shows something: text, attachments, or both. */
function hasBody(b: RenderBlock): boolean {
  return b.text.trim() !== "" || (b.attachments?.length ?? 0) > 0;
}

/** The blocks that always belong to the agent's work row: its thinking, tool
 *  calls, and subagent lifecycle records. */
function isWorkBlock(b: RenderBlock): boolean {
  return (
    b.kind === "reasoning" ||
    b.kind === "tool" ||
    b.kind === "child_spawn" ||
    b.kind === "child_result" ||
    b.kind === "child_closed"
  );
}

/** The first wall-clock stamp in the run: a tool's issue time, or another
 *  record's own time. Blocks without a stamp are skipped, so a run that
 *  opens on an intermediate message still times from its first real step. */
function stampOf(run: RenderBlock[]): string | undefined {
  for (const b of run) {
    const ts = b.kind === "tool" ? b.tool?.ts : b.ts;
    if (ts) return ts;
  }
  return undefined;
}

/** The last wall-clock stamp in the run: a tool's result time when it has
 *  one, otherwise its issue time. */
function endStampOf(run: RenderBlock[]): string | undefined {
  for (let i = run.length - 1; i >= 0; i -= 1) {
    const b = run[i]!;
    const ts = b.kind === "tool" ? (b.tool?.endTs ?? b.tool?.ts) : b.ts;
    if (ts) return ts;
  }
  return undefined;
}

export function workRunLabel(
  run: RenderBlock[],
  active: boolean,
  stopping: boolean,
  nowMs: number,
  turnStart?: string,
): string {
  const ownStart = stampOf(run);
  // Live counting anchors to the turn start (starts at 0, no per-step
  // resets); a settled run keeps its own open-to-end duration.
  const start = (active && turnStart) || ownStart;
  const end = endStampOf(run);
  const secs = (() => {
    if (!start) return null;
    const to = active ? nowMs : end ? Date.parse(end) : null;
    if (to === null || Number.isNaN(to)) return null;
    // Floor, not round: a 0.5s run must read as sub-second (hidden), never
    // round up to a fictional "1 seconds".
    return Math.max(0, Math.floor((to - Date.parse(start)) / 1000));
  })();
  if (stopping) return "Agent is stopping";
  if (active) return secs !== null ? `Agent is working ${formatDuration(secs)}` : "Agent is working";
  // A settled run always gets a label: its details stay reachable behind the
  // same row even when the duration is unknown or under a second.
  if (secs === null || secs < 1) return "Agent worked";
  return `Agent worked for ${formatDuration(secs)}`;
}

export const WorkedForBlock = memo(function WorkedForBlock({
  run,
  active,
  stopping,
  turnStart,
  children,
}: {
  run: RenderBlock[];
  active: boolean;
  stopping: boolean;
  turnStart?: string;
  children: React.ReactNode;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!active || stopping) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, stopping]);
  const label = workRunLabel(run, active, stopping, nowMs, turnStart);
  // The top padding — not a margin — clears the hover-stamp band under the
  // preceding message: the band hangs 4..16px below it, and sibling margins
  // collapse into the list's own 20px rhythm, so only padding moves the
  // label. It keeps the timestamp's gaps equal above and below.
  return (
    <Frame className="mt-0! mb-2.5! pt-2! pb-0" title={<span className={active ? "animate-pulse" : ""}>{label}</span>}>
      <div className="flex flex-col">{children}</div>
    </Frame>
  );
});
