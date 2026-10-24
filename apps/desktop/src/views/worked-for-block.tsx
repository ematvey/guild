import { memo, useEffect, useState } from "react";
import { Frame } from "./frame";
import type { Block } from "../lib/thread-reducer";

export type ViewEntry =
  | { kind: "plain"; b: Block; i: number }
  | { kind: "work"; run: Block[]; turnStart?: string };

/// Transcript entries. Each CONTIGUOUS thinking/tool run collapses into one
/// work entry; every other block stays 1:1. The pending run is flushed when
/// a non-run block arrives, so a work entry sits where its run was and never
/// trails the text that followed it.
///
/// The live "Agent is working Ns" clock anchors to the TURN's user message,
/// not the run's own open-time: the turn is what the user is waiting on, so
/// the counter starts at 0 when the agent begins and never resets between
/// steps (per-run open-times are polluted anyway — a state publish carrying
/// the next step's buffer can arrive before the previous step's commit,
/// making the new live block inherit the old open-time). Settled runs keep
/// their own per-run duration.
export function viewEntries(blocks: Block[]): ViewEntry[] {
  const entries: ViewEntry[] = [];
  let run: Block[] = [];
  let turnStart: string | undefined;
  const flush = () => {
    if (run.length) entries.push({ kind: "work", run, turnStart });
    run = [];
  };
  blocks.forEach((b, i) => {
    if (b.kind === "user") turnStart = b.ts;
    if (b.kind === "reasoning" || b.kind === "tool") {
      run.push(b);
      return;
    }
    flush();
    entries.push({ kind: "plain", b, i });
  });
  flush();
  return entries;
}

export function workRunLabel(
  run: Block[],
  active: boolean,
  stopping: boolean,
  nowMs: number,
  turnStart?: string,
): string {
  const ownStart = run[0]?.kind === "tool" ? run[0].tool?.ts : run[0]?.ts;
  // Live counting anchors to the turn start (starts at 0, no per-step
  // resets); a settled run keeps its own open-to-end duration.
  const start = (active && turnStart) || ownStart;
  const last = run[run.length - 1];
  const end = last.kind === "tool" ? (last.tool?.endTs ?? last.tool?.ts) : last.ts;
  const secs = (() => {
    if (!start) return null;
    const to = active ? nowMs : end ? Date.parse(end) : null;
    if (to === null || isNaN(to)) return null;
    // Floor, not round: a 0.5s run must read as sub-second (hidden), never
    // round up to a fictional "1 seconds".
    return Math.max(0, Math.floor((to - Date.parse(start)) / 1000));
  })();
  if (stopping) return "Agent is stopping";
  if (active) return secs !== null ? `Agent is working ${secs}s` : "Agent is working";
  // A settled run always gets a label: its details stay reachable behind the
  // same row even when the duration is unknown or under a second.
  if (secs === null || secs < 1) return "Agent worked";
  if (secs < 60) return `Agent worked for ${secs} ${secs === 1 ? "second" : "seconds"}`;
  return `Agent worked for ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export const WorkedForBlock = memo(function WorkedForBlock({ run, active, stopping, turnStart, children }: {
  run: Block[];
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
  const steps = run.length;
  const stepText = `${steps} ${steps === 1 ? "step" : "steps"}`;
  // The top padding — not a margin — clears the hover-stamp band under the
  // preceding message: the band hangs 4..16px below it, and sibling margins
  // collapse into the list's own 20px rhythm, so only padding moves the
  // label. It keeps the timestamp's gaps equal above and below.
  return (
    <Frame
      className="mt-0! mb-2.5! pt-2! pb-0"
      title={
        <>
          <span className={active ? "animate-pulse" : ""}>{label}</span>
          <span className="ml-2 text-muted-foreground/70">({stepText})</span>
        </>
      }
    >
      <div className="space-y-1">{children}</div>
    </Frame>
  );
});
