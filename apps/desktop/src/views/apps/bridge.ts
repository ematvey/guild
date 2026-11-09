// The client's side of the App bridge. The App's page runs in a frame with an
// opaque origin and no network; it reaches Guild only by `postMessage`, and
// this module answers. A message counts only when it comes from that frame's
// window. The page names a data function and its parameters; the call goes
// out with the viewer's own session, after the viewer said yes when the
// function changes data.

import type { CallResult, ConfirmAnswer, ViewerFunction } from "./apps-api";

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
  /** Asks the viewer to approve one function; concurrent asks for the same
   *  function share one question (see `sharedConfirm`). */
  confirm(fn: ViewerFunction, params: unknown): Promise<ConfirmAnswer>;
  call(name: string, params: unknown, confirmed: boolean, remember: boolean): Promise<CallResult>;
  /** Records that the viewer chose "always allow", so later calls skip the
   *  question. */
  granted(name: string): void;
}

/** Answers one `call`: the reply message the page receives. A function the
 *  viewer must approve asks first, unless they already chose "always allow"
 *  for it. */
export async function answerCall(
  message: Extract<PageMessage, { op: "call" }>,
  deps: CallDeps,
): Promise<{ guild: 1; id: number; ok: boolean; result?: PageResult; error?: string }> {
  const fail = (error: string) => ({ guild: 1 as const, id: message.id, ok: false, error });
  const fn = deps.functions.find((item) => item.name === message.name);
  if (fn === undefined) return fail(`this app has no function "${message.name}"`);
  if (!fn.available) return fail(fn.reason ?? `${fn.name} is not available to you`);
  let confirmed = false;
  let remember = false;
  if (fn.confirm && !fn.granted) {
    const answer = await deps.confirm(fn, message.params);
    if (answer === "decline") return fail("you declined this action");
    confirmed = true;
    remember = answer === "always";
    if (remember) deps.granted(fn.name);
  }
  try {
    const result = await deps.call(fn.name, message.params, confirmed, remember);
    if (!result.ok) return fail(result.error);
    return { guild: 1, id: message.id, ok: true, result: pageResult(result.content, result.meta) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** One question per function at a time: a call that arrives while its
 *  function's question is open waits for the same answer instead of opening
 *  another dialog (a dashboard fires many calls of one function at once). */
export function sharedConfirm(
  ask: (fn: ViewerFunction, params: unknown) => Promise<ConfirmAnswer>,
): (fn: ViewerFunction, params: unknown) => Promise<ConfirmAnswer> {
  const open = new Map<string, Promise<ConfirmAnswer>>();
  return (fn, params) => {
    const pending = open.get(fn.name);
    if (pending !== undefined) return pending;
    const next = ask(fn, params).finally(() => open.delete(fn.name));
    open.set(fn.name, next);
    return next;
  };
}

/** The request a function makes, for the confirmation: the method and path
 *  of a raw API tool, or the tool's name. */
export function requestLine(fn: ViewerFunction): string {
  const method = fn.args["method"];
  const path = fn.args["path"];
  if (typeof path === "string") return `${typeof method === "string" ? method.toUpperCase() : "GET"} ${path}`;
  return `${fn.integration}/${fn.tool}`;
}
