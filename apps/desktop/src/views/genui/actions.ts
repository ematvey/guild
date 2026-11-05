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

/** Whether the block's message is still streaming: fields and buttons
 *  stay disabled until it settles. */
export const GenuiStreamingContext = createContext(false);

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
