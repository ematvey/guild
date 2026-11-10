// Shared presentation primitives for the agents surface. All styling uses
// the existing @guild/ui tokens and primitives; this file is not a second
// design system.

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { Agent } from "@guild/wire/rest";
import { Badge } from "@guild/ui/components/badge";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import {
  AGENT_STATUS_LABEL,
  RUN_STATUS_LABEL,
  agentAccessLabel,
  type AgentStatus,
  type RunStatus,
  type Tone,
} from "./agents-route";

const toneClass: Record<Tone, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  success: "border-emerald-700/40 bg-emerald-500/10 text-emerald-500",
  warning: "border-amber-700/40 bg-amber-500/10 text-amber-500",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-sky-700/40 bg-sky-500/10 text-sky-500",
};

export function ToneBadge({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <Badge variant="outline" className={toneClass[tone]} title={title}>
      {children}
    </Badge>
  );
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const tone: Tone =
    status === "active"
      ? "success"
      : status === "archived"
        ? "warning"
        : status === "deleting"
          ? "danger"
          : "neutral";
  return <ToneBadge tone={tone}>{AGENT_STATUS_LABEL[status]}</ToneBadge>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const tone: Tone =
    status === "succeeded"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "running"
          ? "info"
          : status === "queued"
            ? "warning"
            : "neutral";
  return <ToneBadge tone={tone}>{RUN_STATUS_LABEL[status]}</ToneBadge>;
}

/** Who can reach the agent, in one word: everyone, the people it is shared
 *  with, or the owner alone. */
export function VisibilityBadge({ agent }: { agent: Agent }) {
  return (
    <ToneBadge tone="neutral" title="Who can see and use this agent">
      {agentAccessLabel(agent)}
    </ToneBadge>
  );
}

/** Initials from the first letters of the first two words — the agent
 *  glyph, distinct from the avatar chip's first two characters. */
export function nameInitials(label: string | null | undefined): string {
  const text = (label ?? "").trim();
  if (text === "") return "?";
  const parts = text.split(/\s+/);
  if (parts.length === 1) return text.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function AgentGlyph({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-xs font-semibold text-secondary-foreground ${className}`}
    >
      {nameInitials(name)}
    </span>
  );
}

export function TabBar<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-0.5 overflow-x-auto"
    >
      {tabs.map(([id, text]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          aria-label={`${text} tab`}
          onClick={() => onChange(id)}
          className={`-mb-px shrink-0 border-b-2 px-3 pb-2 pt-2 text-sm outline-none transition-colors ${
            value === id
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Page body wrapper: caps the content width and owns the scroll pane. */
export function PageBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
      <div
        className={`mx-auto w-full max-w-[64rem] px-4 pb-16 pt-5 sm:px-6 ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Could not load this page",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 sm:flex-row sm:items-center"
    >
      <AlertTriangle className="size-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {message !== undefined && message !== "" && (
          <p className="mt-0.5 break-words text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </div>
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function InlineLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** A titled block used by overview/settings sections. */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Monospace path/name text that never widens the page. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs">{children}</span>;
}
