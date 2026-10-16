import { memo, useEffect, useState } from "react";
import type { Block } from "../lib/thread-reducer";

export function workRunLabel(
  run: Block[],
  active: boolean,
  stopping: boolean,
  nowMs: number,
  turnStart?: string,
): string | null {
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
  if (secs === null || secs < 1) return null;
  if (secs < 60) return `Agent worked for ${secs} ${secs === 1 ? "second" : "seconds"}`;
  return `Agent worked for ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export const WorkedForBlock = memo(function WorkedForBlock({ run, active, stopping, turnStart }: {
  run: Block[];
  active: boolean;
  stopping: boolean;
  turnStart?: string;
}) {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!active || stopping) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, stopping]);
  const label = workRunLabel(run, active, stopping, nowMs, turnStart);
  if (label === null) return null;
  return (
    <div className="-mt-1.5! mb-2.5! py-0 text-sm text-muted-foreground">
      {active ? <span className="animate-pulse">{label}</span> : label}
    </div>
  );
});
