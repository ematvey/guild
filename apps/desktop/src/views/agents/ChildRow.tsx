// One compact transcript row per spawn (decision 16): agent name, status
// dot, client-computed elapsed time, and the cancel/close actions on hover.
// The whole row opens the child chat; a row without a chat id is inert.

import { useEffect, useState } from "react";
import { ChevronRight, X, XCircle } from "lucide-react";
import { cn } from "@guild/ui/lib/utils";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { childElapsedLabel, childRowOpeners, childStatusLabel, childStatusTone } from "./child-row";
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
  const closed = status === "closed";
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const chatId = row.chatId ?? null;
  const elapsed = childElapsedLabel({ ...row, status, finishedAt: endedAt }, now);
  const tone = childStatusTone(status);

  const act = async (action: "cancel" | "close") => {
    if (!chatId || busy !== null) return;
    setBusy(action);
    setNotice(null);
    const result = await childThreadAction(chatId, action);
    setBusy(null);
    if (result.ok) {
      setStatus(action === "close" ? "closed" : "cancelled");
      setEndedAt(new Date().toISOString());
      if (action === "close") setNotice("Closed");
      return;
    }
    setNotice(result.unavailable ? "Not available yet" : result.error);
  };

  const openers = childRowOpeners(row, onOpen);

  return (
    <div
      role="button"
      tabIndex={chatId ? 0 : -1}
      aria-disabled={chatId ? undefined : true}
      aria-label={`Open ${row.title || row.agentName || "subagent"} chat`}
      onClick={openers.row}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openers.row();
        }
      }}
      className={cn(
        "group flex w-full items-center gap-2 rounded px-1.5 py-1 text-xs outline-none",
        chatId
          ? "cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40"
          : "cursor-default opacity-70",
        closed && "opacity-60",
      )}
    >
      <span
        className={cn("size-2 shrink-0 rounded-full", dotClass[tone])}
        title={childStatusLabel(status)}
        aria-label={childStatusLabel(status)}
      />
      <span
        className={cn(
          "max-w-72 truncate font-medium",
          closed ? "text-muted-foreground" : "text-foreground/80",
        )}
      >
        {row.title || row.agentName || "Subagent"}
      </span>
      {row.title && row.agentName && (
        <span className="max-w-40 shrink-0 truncate text-2xs text-muted-foreground">{row.agentName}</span>
      )}
      {elapsed && <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{elapsed}</span>}
      {notice && <span className="shrink-0 text-2xs text-muted-foreground">{notice}</span>}
      <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {live && (
          <button
            type="button"
            title="Cancel child thread"
            aria-label="Cancel child thread"
            disabled={busy !== null || !chatId}
            onClick={(e) => {
              e.stopPropagation();
              void act("cancel");
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <XCircle className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          title="Close child thread"
          aria-label="Close child thread"
          disabled={busy !== null || !chatId || closed}
          onClick={(e) => {
            e.stopPropagation();
            void act("close");
          }}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        title="Open child chat"
        aria-label={`Open ${row.title || row.agentName || "subagent"} chat`}
        disabled={!chatId}
        onClick={(e) => {
          e.stopPropagation();
          openers.chevron();
        }}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}
