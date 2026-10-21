// Formatting and status helpers shared by the Activity list and the trace
// detail. Pure functions only.

import { RUN_STATUS_LABEL, RUN_TRIGGER_LABEL } from "./agents-route";
import type { SpanRow } from "./agents-api";

export const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

export const money = (v: number): string => (v > 0 ? `$${v.toFixed(4)}` : "—");

export const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

export const time = (iso: string | null): string =>
  iso === null
    ? "—"
    : new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

export const totalTokens = (row: { tokens_in: number; tokens_out: number }): number =>
  row.tokens_in + row.tokens_out;

export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function toneOf(status: string): "success" | "danger" | "info" | "warning" | "neutral" {
  if (status === "succeeded" || status === "ok") return "success";
  if (status === "failed" || status === "error") return "danger";
  if (status === "running") return "info";
  if (status === "queued") return "warning";
  return "neutral";
}

export function statusLabel(status: string): string {
  if (status === "ok") return "ok";
  if (status === "error") return "error";
  return RUN_STATUS_LABEL[status as keyof typeof RUN_STATUS_LABEL] ?? status;
}

export function triggerLabel(trigger: string): string {
  return RUN_TRIGGER_LABEL[trigger as keyof typeof RUN_TRIGGER_LABEL] ?? trigger;
}

/** One-line span preview: LLM output or tool input. */
export function spanPreview(span: SpanRow): string {
  const source = span.span_type === "llm" ? span.output : span.input;
  const text = source.replace(/\s+/g, " ").trim();
  return text === "" ? span.error : text.slice(0, 180);
}
