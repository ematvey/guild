// One compact transcript row per spawn (decision 16): agent name, status
// dot, client-computed elapsed time, one chevron into the child thread, and
// the cancel/close actions. No card, no nested transcript, no header strip.

import { useEffect, useState } from "react";
import { ChevronRight, X, XCircle } from "lucide-react";
import { cn } from "@guild/ui/lib/utils";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { childElapsedLabel, childStatusLabel, childStatusTone } from "./child-row";
import { childThreadAction } from "./agents-api";

const dotClass: Record<ReturnType<typeof childStatusTone>, string> = {
  running: "animate-pulse bg-sky-500",
  success: "bg-emerald-500",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

export function ChildRow({ row, onOpen }: { row: ChildRowData; onOpen: (chatId: string) => void }) {
  const [now, setNow] = useState(Date.now);
  const [status, setStatus] = useState(row.status);
  const [endedAt, setEndedAt] = useState<string | undefined>(row.finishedAt);
  const [busy, setBusy] = useState<"cancel" | "close" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setStatus(row.status);
    setEndedAt(row.finishedAt);
  }, [row.status, row.finishedAt]);

  const live = status === "running" || status === "queued";
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const target = row.chatId ?? row.threadId;
  const elapsed = childElapsedLabel({ ...row, status, finishedAt: endedAt }, now);
  const tone = childStatusTone(status);

  const act = async (action: "cancel" | "close") => {
    if (!target || busy !== null) return;
    setBusy(action);
    setNotice(null);
    const result = await childThreadAction(target, action);
    setBusy(null);
    if (result.ok) {
      setStatus(action === "close" ? "cancelled" : "cancelled");
      setEndedAt(new Date().toISOString());
      if (action === "close") setNotice("Closed");
      return;
    }
    setNotice(result.unavailable ? "Not available yet" : result.error);
  };

  return (
    <div className="group flex w-fit max-w-full items-center gap-2 py-1 text-xs">
      <span
        className={cn("size-2 shrink-0 rounded-full", dotClass[tone])}
        title={childStatusLabel(status)}
        aria-label={childStatusLabel(status)}
      />
      <span className="max-w-72 truncate font-medium text-foreground/80">
        {row.agentName || "Subagent"}
      </span>
      {elapsed && <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{elapsed}</span>}
      {notice && <span className="shrink-0 text-2xs text-muted-foreground">{notice}</span>}
      <div className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {live && (
          <button
            type="button"
            title="Cancel child thread"
            aria-label="Cancel child thread"
            disabled={busy !== null}
            onClick={() => void act("cancel")}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <XCircle className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Close child thread"
          aria-label="Close child thread"
          disabled={busy !== null}
          onClick={() => void act("close")}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        title="Open child thread"
        aria-label={`Open ${row.agentName || "subagent"} thread`}
        disabled={!target}
        onClick={() => target && onOpen(target)}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
