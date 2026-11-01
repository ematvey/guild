//! The daemon-side file bridge: the only way this client touches local
//! files. Rust exposes the allowlisted `fs.*` verbs over the app-process
//! RPC channel; browser mode has no local files and returns empty results.


/** What a directory entry looks like over the bridge. */
export interface DirEntry {
  name: string;
  kind: "dir" | "file" | "other";
}

/**
 * The daemon-side file bridge. Browser mode returns empty results —
 * there are no local files there (server-side AGENTS.md for web chats is
 * phase 5a, machine-mediated).
 */
export interface BridgeFs {
  scopes(): Promise<{ configDir: string | null; home: string | null }>;
  readText(projectDir: string | undefined, path: string): Promise<string | null>;
  listDir(projectDir: string | undefined, path: string): Promise<DirEntry[]>;
  exists(projectDir: string | undefined, path: string): Promise<boolean>;
  writeText(projectDir: string | undefined, path: string, body: string): Promise<boolean>;
}

const emptyFs: BridgeFs = {
  scopes: async () => ({ configDir: null, home: null }),
  readText: async () => null,
  listDir: async () => [],
  exists: async () => false,
  writeText: async () => false,
};

/** The engine call the bridge rides on (machine-rpc's rpcCall). */
export type BridgeRpc = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<{ result?: unknown } | null | undefined>;

/** The `fs.*` verbs' reply shapes; any field may be missing. */
interface FsReplies {
  "fs.scopes": { config_dir?: string | null; home?: string | null };
  "fs.read_text": { content?: string | null };
  "fs.list_dir": { entries?: DirEntry[] };
  "fs.exists": { exists?: boolean };
  "fs.write_text": { ok?: boolean };
}

/** The real bridge: `fs.*` verbs over the app-process RPC channel. */
export function daemonFs(rpcCall: BridgeRpc): BridgeFs {
  const call = async <M extends keyof FsReplies>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<FsReplies[M] | null> => {
    try {
      const res = await rpcCall(method, params, 15_000);
      const result = res?.result;
      return typeof result === "object" && result !== null ? (result as FsReplies[M]) : null;
    } catch {
      return null;
    }
  };
  const scoped = (projectDir: string | undefined) => (projectDir ? { project_dir: projectDir } : {});
  return {
    scopes: async () => {
      const r = await call("fs.scopes", {});
      return { configDir: r?.config_dir ?? null, home: r?.home ?? null };
    },
    readText: async (projectDir, path) => {
      const r = await call("fs.read_text", { ...scoped(projectDir), path });
      return r?.content ?? null;
    },
    listDir: async (projectDir, path) => {
      const r = await call("fs.list_dir", { ...scoped(projectDir), path });
      return r?.entries ?? [];
    },
    exists: async (projectDir, path) => {
      const r = await call("fs.exists", { ...scoped(projectDir), path });
      return r?.exists === true;
    },
    writeText: async (projectDir, path, body) => {
      const r = await call("fs.write_text", { ...scoped(projectDir), path, body });
      return r?.ok === true;
    },
  };
}

/** Browser-mode bridge: no local files, everything empty. */
export const browserFs: BridgeFs = emptyFs;

export function parentOf(dir: string): string | null {
  const normalized = dir.replaceAll("\\", "/").replace(/\/$/, "");
  if (/^[a-z]:$/i.test(normalized) || /^\/\/[^/]+\/[^/]+$/.test(normalized)) return null;
  const i = normalized.lastIndexOf("/");
  if (i <= 0) return null;
  const parent = normalized.slice(0, i);
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
}
