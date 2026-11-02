// The selected span's pane: overview, input, output and attributes, with
// readable JSON and the model response's tool calls.

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Wrench } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@guild/ui/lib/utils";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import { getSpanPayloads, type SpanRow } from "./agents-api";
import { compact, money, ms, statusLabel, toneOf } from "./activity-format";
import { JsonView } from "./JsonView";
import { MessagesView, payloadMessages } from "./MessagesView";
import { ToneBadge } from "./agent-ui";
import { useTransientFlag } from "../../lib/use-transient";
import { Meta, parseObject, SpanIcon } from "./trace-views";

export function SpanDetail({ span, admin }: { span: SpanRow | null; admin: boolean }) {
  const [payloads, setPayloads] = useState<{ kind: string; body: string }[] | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState(false);

  useEffect(() => {
    setRawInput(false);
  }, [span?.span_id, span?.span_type]);

  useEffect(() => {
    setPayloads(null);
    setPayloadError(null);
    if (span === null || !admin || span.span_type !== "llm") return;
    let live = true;
    void getSpanPayloads(span.span_id)
      .then((rows) => {
        if (live) setPayloads(rows);
      })
      .catch((err: unknown) => {
        if (live) setPayloadError(err instanceof Error ? err.message : "Payloads did not load.");
      });
    return () => {
      live = false;
    };
  }, [span?.span_id, span?.span_type, admin]);

  if (span === null) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-2xs text-muted-foreground">
        Select a span to inspect its input, output and attributes.
      </div>
    );
  }

  const requestRaw = payloads?.find((row) => row.kind === "request")?.body ?? "";
  const responseRaw = payloads?.find((row) => row.kind === "response")?.body ?? "";
  const request = parseObject(requestRaw);
  const response = parseObject(responseRaw);
  const messages = payloadMessages(request?.["messages"]);
  const responseContent = typeof response?.["content"] === "string" ? response["content"] : "";
  const inputText = messages !== null && !rawInput ? JSON.stringify(request?.["messages"]) : span.input || requestRaw;
  const outputText = responseContent || span.output || responseRaw;
  const attributesText = JSON.stringify(span.attributes, null, 2);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SpanIcon span={span} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{span.name}</span>
        <span className="shrink-0">
          <ToneBadge tone={toneOf(span.status)}>{statusLabel(span.status)}</ToneBadge>
        </span>
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{ms(span.duration_ms)}</span>
      </div>
      <div className="divide-y divide-border">
        {span.span_type === "llm" && (
          <SpanSection title="Overview">
            <SpanOverview span={span} />
          </SpanSection>
        )}
        <SpanSection title="Input" copy={inputText}>
          {span.span_type === "llm" && messages !== null && messages.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRawInput(false)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-2xs",
                    !rawInput ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Messages
                </button>
                <button
                  type="button"
                  onClick={() => setRawInput(true)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-2xs",
                    rawInput ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  JSON
                </button>
              </div>
              {rawInput ? <JsonView value={requestRaw} /> : <MessagesView messages={messages} />}
            </div>
          ) : (
            <PayloadValue
              value={span.input}
              empty={
                span.span_type === "llm"
                  ? admin
                    ? "No input payload was captured for this call."
                    : "Payload bodies are admin-only."
                  : "No input was recorded."
              }
            />
          )}
        </SpanSection>
        <SpanSection title="Output" copy={outputText}>
          {span.span_type === "llm" && response !== null ? (
            <ResponseView response={response} fallback={span.output || responseRaw} />
          ) : (
            <PayloadValue value={span.output || responseRaw} empty="No output was recorded." />
          )}
        </SpanSection>
        <SpanSection title="Attributes" copy={attributesText}>
          <JsonView value={attributesText} />
        </SpanSection>
      </div>
      {payloadError !== null && <p className="px-3 pb-2 text-2xs text-destructive">{payloadError}</p>}
    </div>
  );
}

export function SpanSection({ title, copy, children }: { title: string; copy?: string; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {copy !== undefined && copy !== "" && <CopyButton value={copy} />}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

export interface ResponseToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: unknown };
}

export function ResponseView({ response, fallback }: { response: Record<string, unknown>; fallback: string }) {
  const content = typeof response["content"] === "string" ? response["content"] : "";
  const reasoning = typeof response["reasoning_content"] === "string" ? response["reasoning_content"] : "";
  const toolCalls = Array.isArray(response["tool_calls"]) ? (response["tool_calls"] as ResponseToolCall[]) : [];
  const hasToolCalls = toolCalls.length > 0;
  if (content === "" && !hasToolCalls && reasoning === "") {
    return <JsonView value={fallback} />;
  }
  return (
    <div className="space-y-2">
      {content !== "" && (
        <div className={cn("text-sm text-foreground", MD_CLASS, MD_TABLE_CLASS)}>
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {content}
          </Markdown>
        </div>
      )}
      {toolCalls.map((call, index) => {
        const name = call.name ?? call.function?.name ?? "tool_call";
        const args = call.arguments ?? call.function?.arguments;
        return (
          <div key={call.id ?? index} className="rounded-md border border-border bg-background/60 p-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Wrench className="size-3 shrink-0 text-emerald-300" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">{name}</span>
            </div>
            {call.id !== undefined && (
              <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{call.id}</p>
            )}
            <JsonView
              value={typeof args === "string" ? args : JSON.stringify(args ?? {})}
              maxHeight="max-h-48"
              className="mt-1"
            />
          </div>
        );
      })}
      {reasoning !== "" && (
        <details>
          <summary className="cursor-pointer text-2xs text-muted-foreground">Reasoning</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
            {reasoning}
          </pre>
        </details>
      )}
    </div>
  );
}

export function SpanOverview({ span }: { span: SpanRow }) {
  const finishReason = typeof span.attributes["finish_reason"] === "string" ? span.attributes["finish_reason"] : "";
  const verdict = span.attributes["verdict"];
  const verdictReason = typeof span.attributes["verdict_reason"] === "string" ? span.attributes["verdict_reason"] : "";
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-2xs">
        <Meta label="Model" value={span.model || "—"} />
        <Meta label="Caller" value={span.caller || "—"} />
        <Meta label="Tokens" value={`${compact(span.tokens_in)} in / ${compact(span.tokens_out)} out`} />
        <Meta label="Cost" value={money(span.cost_usd)} />
        <Meta label="Latency" value={ms(span.duration_ms)} />
        <Meta label="Status" value={statusLabel(span.status)} />
        {finishReason !== "" && <Meta label="Finish" value={finishReason} />}
        {verdict !== undefined && verdict !== null && <Meta label="Verdict" value={String(verdict)} />}
      </dl>
      {verdictReason !== "" && <p className="text-2xs text-muted-foreground">{verdictReason}</p>}
      {span.error !== "" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-2xs text-destructive">
          {span.error}
        </p>
      )}
    </div>
  );
}

export function PayloadValue({ value, empty }: { value: string; empty: string }) {
  if (value.trim() === "") {
    return <p className="text-2xs text-muted-foreground">{empty}</p>;
  }
  return <JsonView value={value} />;
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, flashCopied] = useTransientFlag(1200);
  return (
    <button
      type="button"
      aria-label="Copy value"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          flashCopied();
        });
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}
