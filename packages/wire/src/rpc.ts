// The line-delimited JSON-RPC 2.0 envelope between the desktop UI and the
// engine, and over the local CLI socket, hand-written from
// protocol/rpc.schema.json. The schema is the contract. Presence follows it
// exactly: an optional field is `field?: T`; an always-serialized plain field
// is `field: T`.

import type { UserInfo } from "./rest.js";

/** Any JSON value. serde_json::Value in Rust. */
export type Json = unknown;

/** A request from client to server. Either side can be the client. */
export interface Request {
  jsonrpc: "2.0";
  /** A JSON number, not a bigint. u64 in Rust. */
  id: number;
  protocol: number;
  method: string;
  /** Always present; `#[serde(default)]`. */
  params: Json;
}

/** The error arm of a Response. */
export interface RpcError {
  /** A JSON number. i64 in Rust; the app base is -32000. */
  code: number;
  message: string;
  data?: Json;
}

/** A reply to a Request. Exactly one of result and error is present. */
export interface Response {
  jsonrpc: "2.0";
  id: number;
  protocol: number;
  /** Omitted on the error arm. */
  result?: Json;
  /** Omitted on the success arm. */
  error?: RpcError;
}

/** An unsolicited engine line: `rpc.error`, for an unparseable request
 *  line that carried no id. */
export interface Event {
  protocol: number;
  event: string;
  /** Always present; `#[serde(default)]`. */
  payload: Json;
}

// ---- Method params and results (rpc.schema.json `methods`) ----

/** A method that takes no params: `{}`. */
export type NoParams = Record<string, unknown>;

export interface OkResult {
  ok: true;
}

export interface LoginParams {
  base_url: string;
  email: string;
  password: string;
  /** The webview's per-install machine id. */
  machine_id?: string;
}

export interface PairParams {
  /** `g1|<server_url>|<secret>`. */
  code: string;
  machine_id?: string;
}

export interface LoginResult {
  ok: true;
  user: UserInfo;
}

/** The active session (`session.info`, `workspace.switch`). */
export interface SessionResult {
  base_url: string;
  token: string;
  email: string | null;
}

export interface SessionClearParams {
  /** The workspace to sign out of; omitted, the active one. */
  base_url?: string;
}

export interface WorkspaceListResult {
  active: string | null;
  workspaces: Json[];
}

export interface WorkspaceSwitchParams {
  base_url: string;
}

export interface MachineIdentifyParams {
  machine_id: string;
}

export interface DaemonHelloResult {
  version: string;
  protocol: number;
  build: string;
  pid: number;
}

export interface RegistryPublishParams {
  kind: string;
  dir: string;
  version: string;
}

export interface RegistryPublishResult {
  slug: string;
  version: string;
}

export interface RegistryInstallParams {
  slug: string;
  version?: string | null;
  /** Required unless `global`; per call. */
  project_dir?: string;
  global?: boolean;
}

export interface RegistryInstallResult {
  name: string;
  path: string;
}

export interface RegistryUninstallParams {
  slug: string;
  /** Required unless `global`; per call. */
  project_dir?: string | null;
  global?: boolean;
}

export interface RegistryUninstallResult {
  uninstalled: string;
}

export interface FsScopesResult {
  config_dir: string;
  home: string;
}

export interface FsPathParams {
  /** Absolute, or relative to `project_dir`. */
  path: string;
  project_dir?: string;
}

export interface FsWriteTextParams {
  path: string;
  body: string;
  project_dir?: string;
}

export interface FsReadTextResult {
  content: string;
}

/** A symlink is classified by its target; a dangling one is `other`. */
export interface FsDirEntry {
  name: string;
  kind: "dir" | "file" | "other";
}

export interface FsListDirResult {
  entries: FsDirEntry[];
}

export interface FsExistsResult {
  exists: boolean;
}
