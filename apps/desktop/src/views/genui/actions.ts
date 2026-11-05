// What a click inside a Generated UI block does. Two actions leave the
// block: @ToAssistant becomes the user's next message in the thread, and
// @OpenUrl opens the link outside the app. Every other event (custom
// actions, which the library does not define) is dropped.

import { createContext } from "react";

/** A Generated UI event, as the renderer reports it. */
export interface GenuiEvent {
  type: string;
  params: Record<string, unknown>;
  humanFriendlyMessage: string;
  formState?: Record<string, unknown>;
  formName?: string;
}

/** What the thread does for a block: send a message as the user. Absent
 *  where the transcript is read-only (Activity, traces), so the blocks
 *  render but their buttons do nothing. */
export interface GenuiHost {
  send: (text: string) => void;
}

export const GenuiHostContext = createContext<GenuiHost | null>(null);

/** Where the block's message stands in the thread. `streaming`: the turn
 *  is still writing it. `answer`: the text of the first user message after
 *  it, or null while nothing follows. A block is a dialog: once answered
 *  (by one of its buttons or by anything the user typed) its controls
 *  settle. Derived from the transcript, so it holds on reload and on every
 *  device. */
export interface GenuiPlacement {
  streaming: boolean;
  answer: string | null;
}

export const GenuiPlacementContext = createContext<GenuiPlacement>({ streaming: false, answer: null });

/** The block's controls accept no input: still streaming, already
 *  answered, or shown where nothing can be sent. Tabs still switch. */
export const GenuiInertContext = createContext(false);

/** The answer that followed the block, for marking the choice that made
 *  it. */
export const GenuiAnswerContext = createContext<string | null>(null);

/** Whether `answer` is what a button sending `message` sent: the button's
 *  message, possibly followed by its form's values. */
export function answeredBy(answer: string | null, message: string): boolean {
  if (answer === null) return false;
  const m = message.trim();
  if (m === "") return false;
  const a = answer.trim();
  return a === m || a.startsWith(`${m}\n`);
}

/** For each block of a transcript, the text of the first user message
 *  after it, or null when none follows. */
export function answersAfter(blocks: readonly { kind: string; text?: string }[]): (string | null)[] {
  const out: (string | null)[] = new Array(blocks.length).fill(null);
  let next: string | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    out[i] = next;
    const b = blocks[i]!;
    if (b.kind === "user") next = b.text ?? "";
  }
  return out;
}

export type GenuiOutcome = { kind: "send"; text: string } | { kind: "open"; url: string } | { kind: "none" };

/** The outcome of one event: the message to send, the URL to open, or
 *  nothing. A sent message carries the submitted form's values as
 *  `name: value` lines and any hidden context as JSON, so the agent reads
 *  exactly what the user saw being submitted. */
export function genuiOutcome(event: GenuiEvent): GenuiOutcome {
  if (event.type === "open_url") {
    const url = typeof event.params["url"] === "string" ? event.params["url"] : "";
    return /^(https?:|mailto:)/i.test(url) ? { kind: "open", url } : { kind: "none" };
  }
  if (event.type !== "continue_conversation") return { kind: "none" };
  const parts: string[] = [];
  const message = event.humanFriendlyMessage.trim();
  if (message !== "") parts.push(message);
  const values = formValues(event);
  if (values.length > 0) parts.push(values.join("\n"));
  const context = event.params["context"];
  if (context !== undefined && context !== null) {
    parts.push(typeof context === "string" ? context : JSON.stringify(context, null, 2));
  }
  return parts.length === 0 ? { kind: "none" } : { kind: "send", text: parts.join("\n\n") };
}

/** The submitted form's fields as `name: value` lines, in field order;
 *  empty fields are left out. Only the form the button belongs to counts. */
function formValues(event: GenuiEvent): string[] {
  if (!event.formName || !event.formState) return [];
  const form = event.formState[event.formName];
  if (!form || typeof form !== "object" || Array.isArray(form)) return [];
  const lines: string[] = [];
  for (const [name, wrapped] of Object.entries(form as Record<string, unknown>)) {
    const value =
      wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) && "value" in wrapped
        ? (wrapped as { value: unknown }).value
        : wrapped;
    if (value === undefined || value === null || value === "") continue;
    const text = Array.isArray(value)
      ? value.join(", ")
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    lines.push(`${name}: ${text}`);
  }
  return lines;
}
