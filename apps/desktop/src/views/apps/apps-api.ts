// The Apps REST surface the page calls: one App as the viewer may call its
// functions, the signed page link, a data-function call, sharing and delete.
// The list itself is socket state (apps-store.ts).

import { request } from "../../lib/api/request";
import type { App, AppParam } from "@guild/wire/rest";

/** One data function as the viewer sees it. */
export interface ViewerFunction {
  name: string;
  description: string;
  integration: string;
  tool: string;
  params: { [name: string]: AppParam };
  /** The tool's class; null when the viewer cannot reach it. */
  class: string | null;
  available: boolean;
  /** The viewer confirms every call: the tool changes data or the org asks. */
  confirm: boolean;
  reason: string | null;
}

export interface AppDetail {
  app: App;
  functions: ViewerFunction[];
}

export type CallResult = { ok: true; content: string; meta: unknown } | { ok: false; error: string };

const base = (id: string) => `/api/v1/apps/${encodeURIComponent(id)}`;

export const getAppDetail = (id: string) => request<AppDetail>("GET", base(id));

export const getAppPageLink = (id: string) =>
  request<{ path: string; version: number }>("GET", `${base(id)}/page_link`);

export const callAppFunction = (id: string, name: string, params: unknown, confirmed: boolean) =>
  request<CallResult>("POST", `${base(id)}/functions/${encodeURIComponent(name)}`, { params, confirmed });

export const setAppVisibility = (id: string, visibility: App["visibility"]) =>
  request<{ app: App }>("PATCH", base(id), { visibility });

export const deleteApp = (id: string) => request<{ deleted: boolean }>("DELETE", base(id));
