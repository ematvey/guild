// The three readings of a trace's spans — transcript, tree and timeline —
// plus the span helpers they share with the span pane.

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Wrench,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@guild/ui/lib/utils";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import {
  type AgentRunStep,
  type SpanRow,
} from "./agents-api";
import { compact, ms, spanPreview, time, totalTokens } from "./activity-format";
import { ToneBadge } from "./agent-ui";

export function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

export function SpanIcon({ span, className }: { span: SpanRow; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded",
        span.status === "error"
          ? "bg-destructive/15 text-destructive"
          : span.span_type === "llm"
            ? "bg-violet-500/15 text-violet-300"
            : "bg-emerald-500/15 text-emerald-300",
        className,
      )}
    >
      {span.span_type === "llm" ? <Bot className="size-3" /> : <Wrench className="size-3" />}
    </span>
  );
}

export function TimelineView({
  spans,
  bounds,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  bounds: { start: number; end: number };
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const total = bounds.end - bounds.start;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div>
      <div className="grid grid-cols-[10rem_minmax(0,1fr)_4.5rem] gap-2 px-1 pb-1 text-2xs tabular-nums text-muted-foreground">
        <span />
        <div className="relative h-4">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${tick * 100}%` }}
            >
              {ms(total * tick)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <div className="space-y-0.5">
        {spans.map((span) => {
          const left = ((Date.parse(span.start_time) - bounds.start) / total) * 100;
          const width = Math.max(0.5, (span.duration_ms / total) * 100);
          return (
            <button
              key={span.span_id}
              type="button"
              onClick={() => onSelect(span)}
              className={cn(
                "grid w-full grid-cols-[10rem_minmax(0,1fr)_4.5rem] items-center gap-2 rounded-sm border-l-2 px-1 py-0.5 text-left transition-colors focus:outline-none",
                selected?.span_id === span.span_id
                  ? "border-l-primary bg-primary/10"
                  : "border-l-transparent hover:bg-accent/40",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <SpanIcon span={span} className="size-4" />
                <span className="truncate">{span.name}</span>
              </span>
              <span className="relative h-5 rounded bg-accent/25">
                {[25, 50, 75].map((tick) => (
                  <span
                    key={tick}
                    className="absolute inset-y-0 border-l border-border/60"
                    style={{ left: `${tick}%` }}
                  />
                ))}
                <span
                  className={cn(
                    "absolute top-0.5 h-4 rounded",
                    span.status === "error"
                      ? "bg-destructive/70"
                      : span.span_type === "llm"
                        ? "bg-violet-500/70"
                        : "bg-emerald-500/70",
                  )}
                  style={{
                    left: `${Math.min(99.5, Math.max(0, left))}%`,
                    width: `${Math.min(100 - Math.max(0, left), Math.max(0.5, width))}%`,
                  }}
                />
              </span>
              <span className="text-right text-2xs tabular-nums text-muted-foreground">{ms(span.duration_ms)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SpanList({
  spans,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  if (spans.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No spans were recorded for this trace.</p>;
  }
  return (
    <div className="divide-y divide-border/50">
      {spans.map((span) => (
        <button
          key={span.span_id}
          type="button"
          onClick={() => onSelect(span)}
          className={cn(
            "flex w-full items-start gap-2 border-l-2 px-2 py-2 text-left transition-colors focus:outline-none",
            selected?.span_id === span.span_id
              ? "border-l-primary bg-primary/10"
              : "border-l-transparent hover:bg-accent/40",
          )}
        >
          <SpanIcon span={span} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{span.name}</span>
              {span.model !== "" && <span className="font-mono text-2xs text-muted-foreground">{span.model}</span>}
              {span.status === "error" && <ToneBadge tone="danger">error</ToneBadge>}
            </span>
            {spanPreview(span) !== "" && (
              <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{spanPreview(span)}</span>
            )}
          </span>
          <span className="shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
            {span.tokens_in + span.tokens_out > 0 && (
              <span className="block">{compact(totalTokens(span))} tok</span>
            )}
            <span className="block">{ms(span.duration_ms)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function TranscriptView({
  spans,
  steps,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  steps: AgentRunStep[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const llm = useMemo(() => spans.filter((span) => span.span_type === "llm"), [spans]);
  const tools = useMemo(() => spans.filter((span) => span.span_type === "tool"), [spans]);
  const toolByCall = useMemo(() => {
    const map = new Map<string, SpanRow>();
    for (const span of tools) {
      const callId = span.attributes["call_id"];
      if (typeof callId === "string") map.set(callId, span);
    }
    return map;
  }, [tools]);

  if (steps.length === 0) return <SpanList spans={spans} selected={selected} onSelect={onSelect} />;

  const nearestLlm = (at: string | null | undefined): SpanRow | null => {
    if (at === null || at === undefined) return null;
    const ts = Date.parse(at);
    if (!Number.isFinite(ts)) return null;
    let best: SpanRow | null = null;
    for (const span of llm) {
      const start = Date.parse(span.start_time);
      if (start <= ts && (best === null || start > Date.parse(best.start_time))) best = span;
    }
    return best;
  };

  return (
    <div className="divide-y divide-border/50">
      {steps.map((step, index) => {
        const key = `${step.kind}-${step.at ?? ""}-${index}`;
        if (step.kind === "user") {
          return (
            <div key={key} className="border-l-2 border-sky-400/60 bg-sky-400/5 px-3 py-2">
              <div className="flex items-center gap-1.5 text-2xs text-sky-300">
                <ArrowRight className="size-3.5" />
                <span className="font-medium uppercase tracking-wide">Input</span>
                {step.at !== null && step.at !== undefined && (
                  <span className="ml-auto text-muted-foreground">{time(step.at)}</span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{step.detail}</p>
            </div>
          );
        }
        if (step.kind === "assistant") {
          const span = nearestLlm(step.at);
          const selectedRow = span !== null && selected?.span_id === span.span_id;
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => span !== null && onSelect(span)}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && span !== null) onSelect(span);
              }}
              className={cn(
                "cursor-pointer border-l-2 px-3 py-2 transition-colors focus:outline-none",
                selectedRow
                  ? "border-l-primary bg-primary/10"
                  : "border-l-violet-400/60 hover:bg-accent/40",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-violet-300">
                <Bot className="size-3.5" />
                <span className="font-medium uppercase tracking-wide">Assistant</span>
                {span !== null && span.model !== "" && (
                  <span className="font-mono text-muted-foreground">{span.model}</span>
                )}
                {span !== null && (
                  <span className="text-muted-foreground">
                    {compact(totalTokens(span))} tok · {ms(span.duration_ms)}
                  </span>
                )}
              </div>
              <div className={cn("mt-1 text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {step.detail ?? ""}
                </Markdown>
              </div>
            </div>
          );
        }
        if (step.kind === "tool") {
          const span =
            (step.call_id !== null && step.call_id !== undefined ? toolByCall.get(step.call_id) : undefined) ??
            tools.find((tool) => tool.name === step.name) ??
            null;
          const selectedRow = span !== null && selected?.span_id === span.span_id;
          const command = toolBody(span, step.detail ?? "");
          const result = step.detail === null || step.detail === undefined ? "" : oneLine(step.detail);
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              onClick={() => span !== null && onSelect(span)}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && span !== null) onSelect(span);
              }}
              className={cn(
                "cursor-pointer border-l-2 px-3 py-2 transition-colors focus:outline-none",
                selectedRow
                  ? "border-l-primary bg-primary/10"
                  : "border-l-emerald-400/60 hover:bg-accent/40",
              )}
            >
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-emerald-300">
                <Wrench className="size-3.5" />
                <span className="font-medium">{step.name ?? "tool"}</span>
                <ToneBadge tone={step.status === "error" ? "danger" : "success"}>
                  {step.status === "error" ? "error" : "ok"}
                </ToneBadge>
                {span !== null && <span className="text-muted-foreground">{ms(span.duration_ms)}</span>}
              </div>
              {(command.body !== "" || command.label !== "") && (
                <div className="mt-1 flex items-start gap-1.5">
                  {command.label !== "" && (
                    <span className="mt-0.5 shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground">
                      {command.label}
                    </span>
                  )}
                  {command.body !== "" && (
                    <pre className="line-clamp-2 overflow-hidden whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
                      {command.body}
                    </pre>
                  )}
                </div>
              )}
              {result !== "" && (
                <p className="mt-0.5 line-clamp-1 overflow-hidden break-words text-2xs text-muted-foreground/80">
                  → {result}
                </p>
              )}
            </div>
          );
        }
        if (step.kind === "file") {
          return (
            <div key={key} className="flex items-center gap-1.5 px-3 py-2 text-2xs text-muted-foreground">
              <FileText className="size-3.5" />
              <span className="font-mono">{step.detail}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export interface SpanNode {
  span: SpanRow;
  children: SpanNode[];
}

export function buildSpanTree(spans: SpanRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>(spans.map((span) => [span.span_id, { span, children: [] }]));
  const roots: SpanNode[] = [];
  const ordered = [...spans].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const llm = ordered.filter((span) => span.span_type === "llm");
  for (const span of ordered) {
    const node = nodes.get(span.span_id);
    if (node === undefined) continue;
    let parentId = span.parent_span_id;
    if (parentId === null || !nodes.has(parentId)) {
      if (span.span_type === "tool") {
        let candidate: SpanRow | null = null;
        for (const call of llm) {
          if (Date.parse(call.start_time) <= Date.parse(span.start_time)) candidate = call;
          else break;
        }
        parentId = candidate?.span_id ?? null;
      } else {
        parentId = null;
      }
    }
    if (parentId !== null && parentId !== span.span_id) {
      nodes.get(parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function SpanTree({
  spans,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  selected: SpanRow | null;
  onSelect: (span: SpanRow) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const roots = useMemo(() => buildSpanTree(spans), [spans]);
  if (spans.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No spans were recorded for this trace.</p>;
  }
  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  function renderNode(node: SpanNode): React.ReactNode {
    const { span } = node;
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(span.span_id);
    const preview = span.span_type === "tool" ? toolBody(span, "").body : spanPreview(span);
    return (
      <li key={span.span_id}>
        <div
          className={cn(
            "group flex h-8 items-center gap-1 border-l-2 pr-1 transition-colors",
            selected?.span_id === span.span_id
              ? "border-l-primary bg-primary/10"
              : "border-l-transparent hover:bg-accent/40",
          )}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={isCollapsed ? "Expand span" : "Collapse span"}
              onClick={() => toggle(span.span_id)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onSelect(span)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
          >
            <SpanIcon span={span} />
            <span className="w-40 shrink-0 truncate text-xs">{span.name}</span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{preview}</span>
            <span className="hidden w-44 shrink-0 truncate font-mono text-2xs text-muted-foreground sm:block">
              {span.model}
            </span>
            <span className="w-14 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
              {span.tokens_in + span.tokens_out > 0 ? compact(totalTokens(span)) : ""}
            </span>
            <span className="w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
              {ms(span.duration_ms)}
            </span>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                span.status === "error" ? "bg-destructive" : "bg-emerald-500",
              )}
            />
          </button>
        </div>
        {hasChildren && !isCollapsed && (
          <ul className="ml-3 border-l border-border/40 pl-2">{node.children.map((child) => renderNode(child))}</ul>
        )}
      </li>
    );
  }
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 border-b border-border/60 px-1 pb-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <span className="size-4 shrink-0" />
        <span className="size-5 shrink-0" />
        <span className="-ml-1.5 w-40 shrink-0">Span</span>
        <span className="min-w-0 flex-1" />
        <span className="hidden w-44 shrink-0 sm:block">Model</span>
        <span className="w-14 shrink-0 text-right">Tokens</span>
        <span className="w-12 shrink-0 text-right">Time</span>
        <span className="w-1.5 shrink-0" />
      </div>
      <ul>{roots.map((node) => renderNode(node))}</ul>
    </div>
  );
}

export function parseObject(value: string): Record<string, unknown> | null {
  if (value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toolBody(span: SpanRow | null, fallback: string): { label: string; body: string } {
  const raw = span !== null && span.input.trim() !== "" ? span.input : fallback;
  const parsed = parseObject(raw);
  if (parsed !== null) {
    if (typeof parsed["command"] === "string") return { label: "bash", body: parsed["command"] };
    if (typeof parsed["path"] === "string") {
      const body =
        typeof parsed["content"] === "string"
          ? parsed["content"]
          : typeof parsed["newText"] === "string"
            ? parsed["newText"]
            : "";
      return { label: parsed["path"], body };
    }
  }
  return { label: "", body: raw };
}
