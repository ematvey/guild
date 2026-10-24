// System-style transcript blocks: the loading skeleton, the reasoning frame,
// the compaction card and the hover stamps under messages.
import { Brain } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Skeleton, SkeletonText } from "@guild/ui/components/skeleton";
import { Frame } from "../frame";
import { PayloadPre } from "../payload-pre";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import type { CompactionBlock } from "../../lib/thread-reducer";

/// Shown while a deep-linked thread's messages are in flight (the URL says
/// /thread/<id> but the view has nothing to render yet). Without this, the
/// new-thread hero would flash for the whole fetch duration.
export function ThreadSkeleton({ width }: { width: number }) {
  return (
    <div role="status" aria-label="Loading conversation" className="min-h-0 flex-1 overflow-hidden">
      <div className="mx-auto w-full space-y-8 px-5 py-6" style={{ maxWidth: width }}>
        <div className="flex justify-end"><Skeleton className="h-4 w-2/5" /></div>
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

/// Collapsible "Thinking" frame for a reasoning block; default collapsed,
/// body is the accumulated thinking text.
export function ReasoningFrame({ text, live }: { text: string; live: boolean }) {
  // Collapsed row carries the head of the thoughts as a preview (CSS
  // truncates to whatever fits on the line); the full text opens below.
  const head = text.replace(/\s+/g, " ").trim();
  return (
    <Frame
      icon={<Brain className="size-3 shrink-0 text-muted-foreground" />}
      title={(open) => (
        <>
          <span className="mr-3 font-medium text-foreground/80">
            {live ? "Thinking…" : "Thinking"}
          </span>
          {/* collapsed only: expanded, the full thoughts show below */}
          {head && !open && (
            <span className="hidden max-w-72 truncate text-muted-foreground sm:inline">
              {head.slice(0, 160)}
            </span>
          )}
        </>
      )}
    >
      {/* Full height in the page flow: the conversation pane owns
          scrolling, the block itself never clips or inner-scrolls. */}
      <PayloadPre text={text || "…"} />
    </Frame>
  );
}

/// Collapsed system-style card for a compaction event: header names the
/// event (and the summarization model); the body holds the summary and the
/// retained-tail note. Always collapsed by default.
export function CompactionCard({ c }: { c: CompactionBlock }) {
  return (
    <Frame title={<span>Context compacted</span>}>
      <div className="space-y-2">
        <div className={`max-h-64 overflow-y-auto leading-relaxed text-muted-foreground ${MD_CLASS} ${MD_TABLE_CLASS}`}>
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>{c.summary}</Markdown>
        </div>
        {c.keepLast != null && <p className="text-muted-foreground">kept last {c.keepLast} messages</p>}
      </div>
    </Frame>
  );
}

/// Hover-revealed message timestamp: always mounted (absolute below the
/// message, hidden via opacity) so showing it never reflows the thread. It
/// sits `mt-3` under the message box — the same step the transcript uses
/// between paragraphs (`space-y-3`), so the stamp reads as the next line of
/// the message rather than a separate element.
/// Locale-aware shortest unambiguous form: time only for today,
/// + month/day within the year, + year for older messages.
export function prettyStamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

export function HoverStamp({ ts, side }: { ts?: string; side: "left" | "right" }) {
  if (!ts) return null;
  const text = prettyStamp(ts);
  if (!text) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute top-full mt-3 ${side === "right" ? "right-0" : "left-0"} text-xs leading-none text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
    >
      {text}
    </div>
  );
}
