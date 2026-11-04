// Registry code plugins: an integration bundle whose manifest says
// `runtime: "code"` carries a plugin.js (one ESM file, the SDK bundled in)
// that the server runs. The bytes come from the org's registry object, are
// checked against the approved sha256, written once to a cache directory
// keyed by that hash, and run in a worker thread (plugin-host.mjs).
//
// The worker contains a plugin's failures — a crash, a hang past the call
// deadline, a leak — and keeps it away from the server's module state (the
// pool, the master key, other orgs' rows). It is not a security sandbox:
// plugin code has the server process's filesystem and network. Admin
// approval of the exact bundle hash is the trust decision.

import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { parseBundle, readBundleFile } from "../platform/bundle.js";
import { bundleSha256 } from "../platform/registry-publish.js";
import { CALL_TIMEOUT_MS, type IntegrationManifest, type JsonObject, type ToolOutcome } from "@guild/integration-sdk";
import { connectorOf, type Connector } from "./loader.js";

/** The bundle entry a code plugin runs. */
export const CODE_ENTRY = "plugin.js";
/** A host call (a whole tool execution included) gets this long before the
 *  worker is terminated and the call fails. Plugin request helpers time out
 *  well inside it. */
const HOST_CALL_DEADLINE_MS = 3 * CALL_TIMEOUT_MS + 60_000;
const MANIFEST_DEADLINE_MS = 15_000;

function cacheRoot(): string {
  return process.env["GUILD_PLUGIN_CACHE"] ?? path.join(tmpdir(), "guild-code-plugins");
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One plugin.js in one worker thread, spawned on first use and respawned
 *  after a crash or a deadline kill. */
export class PluginHost {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly entry: string,
    private readonly label: string,
  ) {}

  private spawn(): Worker {
    const worker = new Worker(new URL("./plugin-host.mjs", import.meta.url), {
      workerData: { entry: this.entry },
      env: {},
    });
    worker.unref();
    worker.on("message", (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const call = this.pending.get(message.id);
      if (call === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.ok) call.resolve(message.value);
      else call.reject(new Error(message.error ?? "plugin call failed"));
    });
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = null;
      for (const [id, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error(`${this.label}: ${error.message}`));
        this.pending.delete(id);
      }
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`plugin worker exited (${code})`)));
    return worker;
  }

  call(op: string, args: unknown, deadlineMs = HOST_CALL_DEADLINE_MS): Promise<unknown> {
    if (this.worker === null) this.worker = this.spawn();
    const worker = this.worker;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: ${op} exceeded ${Math.round(deadlineMs / 1000)}s; the plugin was restarted`));
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
      }, deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, op, args });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) await worker.terminate();
  }
}

/** A loaded code plugin per bundle hash. The hash pins the bytes, so one
 *  load serves every org that approved the same bundle. */
const loaded = new Map<string, Promise<Connector>>();

/** The entry file of one bundle hash, written once (atomically) under the
 *  cache root. */
function materialize(sha256: string, code: Buffer): string {
  const dir = path.join(cacheRoot(), sha256);
  const file = path.join(dir, CODE_ENTRY);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, code);
    renameSync(tmp, file);
  }
  return file;
}

/** The registry manifest fields a code bundle must carry. */
export function isCodeManifest(manifest: JsonObject | null | undefined): boolean {
  return manifest !== null && manifest !== undefined && manifest["runtime"] === "code";
}

async function load(bytes: Buffer, sha256: string, slug: string, version: string): Promise<Connector> {
  const actual = bundleSha256(bytes);
  if (actual !== sha256) throw new Error(`integration ${slug}: bundle bytes do not match the approved hash`);
  const parsed = await parseBundle(bytes);
  const code = readBundleFile(parsed, CODE_ENTRY);
  if (code === null) throw new Error(`integration ${slug}: code bundle has no ${CODE_ENTRY}`);
  const logo = readBundleFile(parsed, "logo.svg")?.toString("utf8") ?? "";
  const host = new PluginHost(materialize(sha256, code), `integration ${slug}`);
  const manifest = (await host.call("manifest", null, MANIFEST_DEADLINE_MS)) as IntegrationManifest;
  if (manifest?.name !== slug) {
    await host.close();
    throw new Error(`integration ${slug}: plugin.js declares slug ${String(manifest?.name)}`);
  }
  if (manifest.version !== version) {
    await host.close();
    throw new Error(`integration ${slug}: plugin.js declares version ${manifest.version}, the bundle ${version}`);
  }
  return connectorOf(manifest, "registry", logo, {
    validate: async (config) => {
      await host.call("validate", { config });
    },
    testConnection: async (config, secrets) => {
      await host.call("testConnection", { config, secrets });
    },
    execute: async (config, tool, args, secrets, actingAs) => {
      const outcome = (await host.call("execute", { config, tool, args, secrets, actingAs })) as ToolOutcome;
      if (outcome?.artifact !== undefined) {
        outcome.artifact = { ...outcome.artifact, bytes: Buffer.from(outcome.artifact.bytes) };
      }
      return outcome;
    },
  });
}

/** The connector of one approved code bundle, loaded at most once per
 *  hash. A failed load is not cached: the next call retries. */
export function loadCodePlugin(
  fetchBytes: () => Promise<Buffer>,
  sha256: string,
  slug: string,
  version: string,
): Promise<Connector> {
  const hit = loaded.get(sha256);
  if (hit !== undefined) return hit;
  const promise = fetchBytes().then((bytes) => load(bytes, sha256, slug, version));
  loaded.set(sha256, promise);
  promise.catch(() => loaded.delete(sha256));
  return promise;
}
