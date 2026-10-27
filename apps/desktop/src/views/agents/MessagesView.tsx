// Chat messages from an LLM request payload: role-colored rows, markdown for
// assistant text, and readable tool-call arguments. Long system prompts stay
// collapsed.

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";
import { JsonView } from "./JsonView";
import type { Json, Message } from "@guild/wire/rest";

/** One message as it appears inside an LLM request payload: OpenAI's shape,
 *  not the protocol's. The mapper below turns it into a Message. */
interface PayloadMessage {
  role?: string;
  content?: string | { type?: string; text?: string; [key: string]: unknown }[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
  reasoning_content?: string;
}

function parseArguments(value: string | undefined): Json {
  if (value === undefined) return {};
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

/** Maps one request payload's messages into the protocol Message shape. */
export function payloadMessages(value: unknown): Message[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((raw) => {
    const row = raw as PayloadMessage;
    const content =
      typeof row.content === "string"
        ? row.content
        : Array.isArray(row.content)
          ? row.content
              .map((part) => (typeof part.text === "string" ? part.text : ""))
              .filter((text) => text !== "")
              .join("\n")
          : "";
    const toolCalls = row.tool_calls?.map((call, index) => ({
      id: call.id ?? String(index),
      name: call.function?.name ?? "tool_call",
      arguments: parseArguments(call.function?.arguments),
    }));
    return {
      role: row.role ?? "unknown",
      content,
      images: [],
      audio: [],
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
      ...(row.tool_call_id !== undefined ? { tool_call_id: row.tool_call_id } : {}),
      ...(row.reasoning_content !== undefined ? { reasoning: row.reasoning_content } : {}),
    };
  });
}

const ROLE_STYLE: Record<string, string> = {
  system: "border-slate-400/50 text-slate-300",
  developer: "border-slate-400/50 text-slate-300",
  user: "border-sky-400/60 text-sky-300",
  assistant: "border-violet-400/60 text-violet-300",
  tool: "border-emerald-400/60 text-emerald-300",
};

function roleClass(role: string | undefined): string {
  return ROLE_STYLE[role ?? ""] ?? "border-border text-muted-foreground";
}

export function MessagesView({
  messages,
  className,
}: {
  messages: Message[];
  className?: string;
}) {
  if (messages.length === 0) {
    return <p className="text-2xs text-muted-foreground">No messages in this payload.</p>;
  }
  return (
    <div className={className}>
      {messages.map((message, index) => {
        const role = message.role;
        const content = message.content;
        const isSystem = role === "system" || role === "developer";
        const text = typeof content === "string" ? content : null;
        return (
          <div
            key={`${role}-${index}`}
            className={`border-l-2 py-2 pl-3 ${roleClass(role)} ${index > 0 ? "border-t border-t-border/40" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
              <span className="shrink-0 font-medium uppercase tracking-wide">{role}</span>
              {message.tool_call_id !== undefined && (
                <span className="min-w-0 max-w-full truncate font-mono text-muted-foreground">
                  {message.tool_call_id}
                </span>
              )}
              {text !== null && (
                <span className="ml-auto shrink-0 text-muted-foreground">{text.length.toLocaleString()} chars</span>
              )}
            </div>
            {isSystem && text !== null ? (
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-2xs text-muted-foreground hover:text-foreground">
                  Show prompt
                </summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-2xs leading-5 text-foreground">
                  {text}
                </pre>
              </details>
            ) : text !== null ? (
              role === "assistant" ? (
                <div className={`mt-1 text-sm text-foreground ${MD_CLASS} ${MD_TABLE_CLASS}`}>
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {text}
                  </Markdown>
                </div>
              ) : (
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm text-foreground">{text}</pre>
              )
            ) : Array.isArray(content) ? (
              <div className="mt-1 space-y-1.5">
                {content.map((part, partIndex) =>
                  typeof part.text === "string" ? (
                    <p key={partIndex} className="whitespace-pre-wrap break-words text-sm text-foreground">
                      {part.text}
                    </p>
                  ) : (
                    <JsonView key={partIndex} value={JSON.stringify(part)} maxHeight="max-h-48" />
                  ),
                )}
              </div>
            ) : null}
            {message.tool_calls !== undefined && message.tool_calls.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {message.tool_calls.map((call, callIndex) => (
                  <div key={call.id ?? callIndex} className="rounded-md border border-border bg-background/60 p-2">
                    <p className="font-mono text-2xs text-foreground">{call.name}</p>
                    <JsonView value={JSON.stringify(call.arguments)} maxHeight="max-h-40" className="mt-1" />
                  </div>
                ))}
              </div>
            )}
            {message.reasoning !== undefined && message.reasoning !== "" && (
              <details className="mt-2">
                <summary className="cursor-pointer select-none text-2xs text-muted-foreground hover:text-foreground">
                  Reasoning
                </summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-2xs leading-5 text-muted-foreground">
                  {message.reasoning}
                </pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
