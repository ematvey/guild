// The client's side of the App bridge. The App's page runs in a frame with an
// opaque origin and no network; it reaches Guild only by `postMessage`, and
// this module answers. A message counts only when it comes from that frame's
// window. The page names a data function and its parameters; the call goes
// out with the viewer's own session, after the viewer said yes when the
// function changes data.

import type { CallResult, ViewerFunction } from "./apps-api";

/** A message from the page: `hello` once the bridge script ran, `call` for
 *  one data function. */
export type PageMessage =
  | { guild: 1; op: "hello" }
  | { guild: 1; op: "call"; id: number; name: string; params: unknown };

/** Reads a page message; null for anything else. */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (data === null || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m["guild"] !== 1) return null;
  if (m["op"] === "hello") return { guild: 1, op: "hello" };
  if (m["op"] === "call" && typeof m["id"] === "number" && typeof m["name"] === "string") {
    return { guild: 1, op: "call", id: m["id"], name: m["name"], params: m["params"] ?? {} };
  }
  return null;
}

/** What the page's `guild.callRaw` resolves with: the tool's text, the text
 *  parsed as JSON when it is JSON (else the text), and the tool's meta. */
export interface PageResult {
  data: unknown;
  text: string;
  meta: unknown;
}

export function pageResult(content: string, meta: unknown): PageResult {
  let data: unknown = content;
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      data = JSON.parse(content);
    } catch {
      data = content;
    }
  }
  return { data, text: content, meta };
}

/** The facts the page gets on `hello`. Only what the page needs: its
 *  functions' names, descriptions and parameters. */
export function initMessage(
  app: { id: string; name: string; version: number },
  functions: ViewerFunction[],
  theme: "light" | "dark",
) {
  return {
    guild: 1,
    op: "init",
    app,
    theme,
    functions: functions.map((fn) => ({
      name: fn.name,
      description: fn.description,
      params: fn.params,
      available: fn.available,
      confirm: fn.confirm,
    })),
  };
}

export interface CallDeps {
  functions: ViewerFunction[];
  /** Asks the viewer to approve one call; resolves false when they decline. */
  confirm(fn: ViewerFunction, params: unknown): Promise<boolean>;
  call(name: string, params: unknown, confirmed: boolean): Promise<CallResult>;
}

/** Answers one `call`: the reply message the page receives. */
export async function answerCall(
  message: Extract<PageMessage, { op: "call" }>,
  deps: CallDeps,
): Promise<{ guild: 1; id: number; ok: boolean; result?: PageResult; error?: string }> {
  const fail = (error: string) => ({ guild: 1 as const, id: message.id, ok: false, error });
  const fn = deps.functions.find((item) => item.name === message.name);
  if (fn === undefined) return fail(`this app has no function "${message.name}"`);
  if (!fn.available) return fail(fn.reason ?? `${fn.name} is not available to you`);
  let confirmed = false;
  if (fn.confirm) {
    confirmed = await deps.confirm(fn, message.params);
    if (!confirmed) return fail("you declined this action");
  }
  try {
    const result = await deps.call(fn.name, message.params, confirmed);
    if (!result.ok) return fail(result.error);
    return { guild: 1, id: message.id, ok: true, result: pageResult(result.content, result.meta) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
