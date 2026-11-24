// System-style transcript blocks: the loading skeleton, the reasoning frame,
// the compaction card and the hover stamps under messages.
import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Copy } from "lucide-react";
import Markdown from "react-markdown";
import { Skeleton, SkeletonText } from "@guild/ui/components/skeleton";
import { Frame } from "../frame";
import { PayloadPre } from "../payload-pre";
import { CHAT_MD_PLUGINS, MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import type { CompactionBlock } from "../../lib/thread-reducer";

/// The conversation column: the transcript, the composer card, the loading
/// skeleton and the jump-to-bottom row share one cap at every breakpoint and
/// narrow with the pane below it.
export const CHAT_COLUMN_CLASS = "mx-auto w-full max-w-[48rem]";

/// Shown while a deep-linked thread's messages are in flight (the URL says
/// /thread/<id> but the view has nothing to render yet). Without this, the
/// new-thread hero would flash for the whole fetch duration.
export function ThreadSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="min-h-0 flex-1 overflow-hidden">
      <div className={`${CHAT_COLUMN_CLASS} space-y-8 px-4 py-6`}>
        <div className="flex justify-end">
          <Skeleton className="h-4 w-2/5" />
        </div>
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

/// A thread swap in flight: one soft band sweeps the top edge. There is no
/// track, so an idle view shows no line.
export function ThreadProgress() {
  return (
    <div role="progressbar" aria-label="Loading thread" className="absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden">
      <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent opacity-70 motion-safe:animate-thread-progress" />
    </div>
  );
}

/// The chat header's title slot: a fixed-size placeholder while the title is
/// still unknown, so the header height never changes when it lands.
export function ThreadTitle({ chatId, title, loading }: { chatId: string | null; title: string; loading: boolean }) {
  if (chatId !== null && loading) {
    return (
      <span className="min-w-0 flex-1">
        <Skeleton className="h-4 w-28 rounded-md" aria-label="Loading title" />
      </span>
    );
  }
  // An empty title is a chat that has not been named yet — a fresh thread
  // stays that way until its first message, so it says so instead of
  // holding a skeleton open forever.
  if (title === "") {
    return <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">New thread</span>;
  }
  return <span className="min-w-0 flex-1 truncate font-medium">{title}</span>;
}

/// Collapsible "Thinking" frame for a reasoning block; default collapsed,
/// body is the accumulated thinking text.
export function ReasoningFrame({ text, live }: { text: string; live: boolean }) {
  // Collapsed row carries the head of the thoughts as a preview (CSS
  // truncates to whatever fits on the line); the full text opens below.
  // Normalizing the live buffer on every delta is pure waste: it changes
  // only when the text changes.
  const head = useMemo(() => text.replace(/\s+/g, " ").trim(), [text]);
  return (
    <Frame
      icon={<Brain className="size-3 shrink-0 text-muted-foreground" />}
      title={(open) => (
        <>
          <span className="mr-3 font-medium text-foreground/80">{live ? "Thinking…" : "Thinking"}</span>
          {/* collapsed only: expanded, the full thoughts show below */}
          {head && !open && (
            <span className="hidden max-w-72 truncate text-muted-foreground sm:inline">{head.slice(0, 160)}</span>
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
          <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>
            {c.summary}
          </Markdown>
        </div>
        {c.keepLast != null && <p className="text-muted-foreground">kept last {c.keepLast} messages</p>}
      </div>
    </Frame>
  );
}

/// Locale-aware shortest unambiguous form: time only for today,
/// + month/day within the year, + year for older messages.
// Stamps repeat for every message on every render. The formatted text only
// changes with the timestamp or with "today" rolling over, so cache it per
// (timestamp, day). The cap keeps a long-lived tab from growing without end.
const STAMP_CACHE_LIMIT = 500;
const stampCache = new Map<string, string>();

export function prettyStamp(iso: string): string {
  const now = new Date();
  const day = now.toDateString();
  const cacheKey = `${iso}|${day}`;
  const cached = stampCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const d = new Date(iso);
  let text = "";
  if (!Number.isNaN(d.getTime())) {
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === day) {
      text = time;
    } else {
      const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
      if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
      text = `${d.toLocaleDateString(undefined, opts)}, ${time}`;
    }
  }
  if (stampCache.size >= STAMP_CACHE_LIMIT) stampCache.clear();
  stampCache.set(cacheKey, text);
  return text;
}

/// The message footer reserves space for the timestamp on hover.
export function HoverStamp({ ts, copyText }: { ts?: string; copyText?: string }) {
  const text = ts ? prettyStamp(ts) : "";
  const canCopy = copyText !== undefined && copyText !== "";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  if (!text && !canCopy) return null;
  return (
    <div
      className="flex items-center gap-2 pt-3 text-base leading-none text-muted-foreground"
    >
      {canCopy && (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          title={copied ? "Copied" : "Copy message"}
          onClick={() => {
            void navigator.clipboard?.writeText(copyText).then(() => setCopied(true));
          }}
          className="-m-1 rounded p-1 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        </button>
      )}
      {text && (
        <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {text}
        </span>
      )}
    </div>
  );
}
