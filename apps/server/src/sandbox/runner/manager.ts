// Sandbox lifecycle on one Docker host: ensure (create/start), agent
// attach, idle stop/remove, capacity, and removal of the containers a
// previous runner process left behind.

import { chown, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { type DockerClient, DockerError, type ExecStream } from "./docker.js";
import {
  LABEL,
  SANDBOX_UID,
  agentExecSpec,
  containerName,
  containerSpec,
  isAgentSubpath,
  validKey,
  validSubpath,
  type RunnerConfig,
} from "./spec.js";

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ContainerSummary {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Running: boolean; Status: string };
  Config: { Labels: Record<string, string> };
}

interface Usage {
  attached: number;
  lastUsed: number;
}

const NAME_PATTERN = /^guild-sbx-[A-Za-z0-9_.-]+-[0-9a-f]{20}$/;

export class SandboxManager {
  private readonly usage = new Map<string, Usage>();
  private reaper: NodeJS.Timeout | null = null;
  private volumeWatch: NodeJS.Timeout | null = null;
  /** Serializes ensure/start per container name. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly config: RunnerConfig,
    private readonly docker: DockerClient,
    private readonly log: Logger,
  ) {}

  /** Boot checks: the runtime exists (and is runsc unless allowed), the
   *  image is present; removes sandboxes a previous runner process left
   *  behind. */
  async start(): Promise<void> {
    const info = await this.docker.request<{ Runtimes: Record<string, unknown> }>("GET", "/info");
    if (!(this.config.runtime in info.Runtimes)) {
      throw new Error(`docker runtime ${this.config.runtime} is not configured on this host`);
    }
    if (this.config.runtime !== "runsc" && !this.config.allowRunc) {
      throw new Error(
        `refusing runtime ${this.config.runtime}: sandboxes require runsc (GUILD_SANDBOX_ALLOW_RUNC=1 overrides)`,
      );
    }
    try {
      await this.docker.request("GET", `/images/${encodeURIComponent(this.config.image)}/json`);
    } catch (error) {
      this.log.warn(
        { err: error, image: this.config.image },
        "sandbox image not found; sandbox creation will fail until it is built",
      );
    }
    await this.prepareDataRoot();
    await this.removeStale();
    this.reaper = setInterval(
      () => void this.reap().catch((error) => this.log.warn({ err: error }, "reap failed")),
      30_000,
    );
    this.reaper.unref();
    this.volumeWatch = setInterval(
      () => void this.volumesAlive().then((dead) => dead !== null && this.restartForVolume(dead)),
      10_000,
    );
    this.volumeWatch.unref();
  }

  /** The dir whose volume this process can no longer read, or null. A JuiceFS
   *  remount leaves every container that bound the volume before it on the
   *  dead FUSE session, this one included. */
  private async volumesAlive(): Promise<string | null> {
    for (const dir of [this.config.agentDataDir, this.config.dataDir]) {
      try {
        await stat(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTCONN") return dir;
      }
    }
    return null;
  }

  /** Only a new container re-resolves the mount, so a dead volume costs the
   *  runner process: the restart policy brings it back, boot re-resolves the
   *  volume and removes the sandboxes left on the dead session. */
  private restartForVolume(dir: string): void {
    this.log.error({ dir }, "sandbox volume is gone; restarting the runner");
    setTimeout(() => process.exit(1), 100).unref();
  }

  /** Refuses work when this process's own volume view is dead: it could not
   *  create the workspace dir, and the client retries after the restart. */
  private async requireVolumes(): Promise<void> {
    const dead = await this.volumesAlive();
    if (dead === null) return;
    this.restartForVolume(dead);
    throw new RunnerError(503, "sandbox runner volume is stale; the runner is restarting");
  }

  /** Sandboxes are disposable: their files live on the volume, and every
   *  agent process died with the previous runner. A container started before
   *  the workspace volume was remounted keeps the dead FUSE session, so
   *  adopting it would serve a workspace whose every operation hangs. Remove
   *  them all; the next ensure creates a fresh one on the live mount. */
  private async removeStale(): Promise<void> {
    const stale = await this.list();
    for (const c of stale) {
      const name = c.Names[0]!.replace(/^\//, "");
      await this.docker.request("DELETE", `/containers/${name}?force=true`).catch((error: unknown) => {
        this.log.warn({ err: error, name }, "stale sandbox removal failed");
      });
    }
    if (stale.length > 0) this.log.info({ count: stale.length }, "removed stale sandboxes");
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    if (this.volumeWatch) clearInterval(this.volumeWatch);
  }

  private async list(): Promise<ContainerSummary[]> {
    const filters = JSON.stringify({ label: [`${LABEL}.project=${this.config.project}`] });
    return this.docker.request<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
  }

  private async inspect(name: string): Promise<ContainerInspect | null> {
    try {
      return await this.docker.request<ContainerInspect>("GET", `/containers/${name}/json`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  }

  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(name, next);
    void next
      .finally(() => {
        if (this.locks.get(name) === next) this.locks.delete(name);
      })
      .catch(() => {});
    return next;
  }

  private touch(name: string): Usage {
    let usage = this.usage.get(name);
    if (usage === undefined) {
      usage = { attached: 0, lastUsed: Date.now() };
      this.usage.set(name, usage);
    }
    usage.lastUsed = Date.now();
    return usage;
  }

  /** The shared volume's root dirs belong to the sandbox uid (= the
   *  server's uid): volumes from before the server ran as non-root are
   *  root-owned, so their trees are handed over once. */
  private async prepareDataRoot(): Promise<void> {
    const root = this.config.dataDir;
    const agentRoot = this.config.agentDataDir;
    for (const dir of [
      root,
      path.join(root, "workspaces"),
      path.join(root, "chats"),
      agentRoot,
      path.join(agentRoot, "agents"),
    ]) {
      await mkdir(dir, { recursive: true });
      const stat = await lstat(dir);
      if (stat.isSymbolicLink()) throw new Error(`${dir} is a symbolic link`);
      if (stat.uid !== SANDBOX_UID) {
        this.log.info({ dir }, "handing data dir to the sandbox uid");
        await this.chownTree(dir, true, false);
      }
    }
  }

  /** Creates the workspace dir on the shared volume (runner side), owned by
   *  the sandbox uid, refusing anything that resolves outside the volume. */
  private async prepareDir(subpath: string): Promise<void> {
    const base = isAgentSubpath(subpath) ? this.config.agentDataDir : this.config.dataDir;
    const root = await realpath(base);
    const dir = path.join(root, subpath);
    await mkdir(dir, { recursive: true });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunnerError(409, "workspace path is not a directory");
    const resolved = await realpath(dir);
    if (resolved !== dir) throw new RunnerError(409, "workspace path resolves elsewhere");
    await mkdir(path.join(dir, ".sandbox-home"), { recursive: true });
    await this.chownTree(dir, stat.uid !== SANDBOX_UID, true);
  }

  /** Hands the workspace to the sandbox uid: the root dir and sandbox home
   *  always, the whole tree when the root was owned by someone else. */
  private async chownTree(dir: string, recursive: boolean, sandboxHome: boolean): Promise<void> {
    const own = async (p: string) => {
      try {
        await chown(p, SANDBOX_UID, SANDBOX_UID);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    };
    await own(dir);
    if (sandboxHome) await own(path.join(dir, ".sandbox-home"));
    if (!recursive) return;
    const walk = async (p: string): Promise<void> => {
      for (const entry of await readdir(p, { withFileTypes: true })) {
        const child = path.join(p, entry.name);
        if (entry.isSymbolicLink()) continue;
        await own(child);
        if (entry.isDirectory()) await walk(child);
      }
    };
    await walk(dir);
  }

  /** Stops least-recently-used idle sandboxes until one more fits. */
  private async makeRoom(except: string): Promise<void> {
    const running = (await this.list()).filter((c) => c.State === "running");
    let excess = running.length - this.config.maxRunning + 1;
    if (excess <= 0) return;
    const idle = running
      .filter((c) => !isAgentSubpath(c.Labels?.[`${LABEL}.subpath`] ?? ""))
      .map((c) => ({ name: c.Names[0]!.replace(/^\//, ""), usage: this.usage.get(c.Names[0]!.replace(/^\//, "")) }))
      .filter((c) => c.name !== except && (c.usage?.attached ?? 0) === 0)
      .sort((a, b) => (a.usage?.lastUsed ?? 0) - (b.usage?.lastUsed ?? 0));
    for (const c of idle) {
      if (excess <= 0) break;
      this.log.info({ name: c.name }, "stopping idle sandbox for capacity");
      await this.docker.request("POST", `/containers/${c.name}/stop?t=5`).catch(() => {});
      excess--;
    }
    if (excess > 0) throw new RunnerError(503, "sandbox capacity reached");
  }

  /** A dead FUSE session answers ENOTCONN from any fs call on the volume,
   *  not only the two root dirs `volumesAlive` probes. Such a failure costs
   *  the process, and the client hears a retryable 503 instead of a 500. */
  private volumeFailure(error: unknown): never {
    if ((error as NodeJS.ErrnoException)?.code === "ENOTCONN") {
      this.restartForVolume(this.config.agentDataDir);
      throw new RunnerError(503, "sandbox runner volume is stale; the runner is restarting");
    }
    throw error;
  }

  /** Idempotent: running → as is; stopped → started; missing → created. */
  async ensure(key: string, subpath: string): Promise<{ name: string; state: string }> {
    if (!validKey(key)) throw new RunnerError(400, "invalid sandbox key");
    if (!validSubpath(subpath)) throw new RunnerError(400, "invalid workspace subpath");
    await this.requireVolumes().catch((error: unknown) => this.volumeFailure(error));
    const name = containerName(this.config, key);
    return this.withLock(name, async () => {
      let existing = await this.inspect(name);
      if (existing !== null) {
        const labels = existing.Config.Labels;
        if (labels[`${LABEL}.key`] !== key || labels[`${LABEL}.subpath`] !== subpath) {
          throw new RunnerError(409, "sandbox name collision");
        }
      } else {
        await this.prepareDir(subpath);
        await this.makeRoom(name);
        await this.docker.request("POST", `/containers/create?name=${name}`, containerSpec(this.config, key, subpath));
        existing = await this.inspect(name);
        this.log.info({ name, key, subpath }, "sandbox created");
      }
      if (!existing!.State.Running) {
        await this.makeRoom(name);
        await this.docker.request("POST", `/containers/${name}/start`);
      }
      this.touch(name);
      return { name, state: "running" };
    }).catch((error: unknown) => this.volumeFailure(error));
  }

  private async owned(name: string): Promise<ContainerInspect> {
    if (!NAME_PATTERN.test(name)) throw new RunnerError(400, "invalid sandbox name");
    const container = await this.inspect(name);
    if (container === null || container.Config.Labels[`${LABEL}.project`] !== this.config.project) {
      throw new RunnerError(404, "no such sandbox");
    }
    return container;
  }

  /** A container started before the workspace volume was remounted keeps the
   *  dead FUSE session: even resolving a binary in PATH fails. Ask the
   *  container itself, with absolute paths so PATH cannot be the answer. */
  private async workspaceAlive(name: string): Promise<boolean> {
    const exec = await this.docker.request<{ Id: string }>("POST", `/containers/${name}/exec`, {
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      Cmd: ["/bin/sh", "-c", "/usr/bin/stat /workspace >/dev/null"],
    });
    await this.docker.request("POST", `/exec/${exec.Id}/start`, { Detach: true, Tty: false });
    for (let i = 0; i < 50; i++) {
      const info = await this.docker.request<{ Running: boolean; ExitCode: number | null }>(
        "GET",
        `/exec/${exec.Id}/json`,
      );
      if (!info.Running) return info.ExitCode === 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /** Starts one agent process in the sandbox and returns its stream. A
   *  sandbox whose mount died is removed, not served: its files live on the
   *  volume, and the next ensure creates a container on the live mount. */
  async attach(name: string): Promise<{ stream: ExecStream; release: () => void }> {
    await this.requireVolumes();
    const container = await this.owned(name);
    if (!container.State.Running) {
      await this.withLock(name, async () => {
        await this.makeRoom(name);
        await this.docker.request("POST", `/containers/${name}/start`);
      });
    }
    if (!(await this.workspaceAlive(name))) {
      this.log.warn({ name }, "sandbox workspace mount is dead; removing the sandbox");
      await this.withLock(name, () => this.removeSandbox(name));
      throw new RunnerError(503, "sandbox workspace mount is dead; the sandbox was removed");
    }
    const exec = await this.docker.request<{ Id: string }>(
      "POST",
      `/containers/${name}/exec`,
      agentExecSpec(this.config),
    );
    const stream = await this.docker.execAttach(exec.Id);
    const usage = this.touch(name);
    usage.attached++;
    let released = false;
    return {
      stream,
      release: () => {
        if (released) return;
        released = true;
        usage.attached--;
        usage.lastUsed = Date.now();
      },
    };
  }

  async stopSandbox(name: string): Promise<void> {
    await this.owned(name);
    await this.docker.request("POST", `/containers/${name}/stop?t=5`);
  }

  async removeSandbox(name: string): Promise<void> {
    await this.owned(name);
    await this.docker.request("DELETE", `/containers/${name}?force=true`);
    this.usage.delete(name);
  }

  async removeByKey(key: string): Promise<void> {
    if (!validKey(key)) throw new RunnerError(400, "invalid sandbox key");
    const name = containerName(this.config, key);
    if ((await this.inspect(name)) === null) return;
    await this.removeSandbox(name);
  }

  /** Stops sandboxes idle past idleStopMs, removes those stopped and idle
   *  past idleRemoveMs. Agent sandboxes are always-on: never reaped. */
  async reap(now = Date.now()): Promise<void> {
    for (const c of await this.list()) {
      const name = c.Names[0]!.replace(/^\//, "");
      if (isAgentSubpath(c.Labels?.[`${LABEL}.subpath`] ?? "")) continue;
      const usage = this.usage.get(name) ?? this.touch(name);
      if (usage.attached > 0) continue;
      const idle = now - usage.lastUsed;
      if (c.State === "running" && idle > this.config.idleStopMs) {
        this.log.info({ name }, "stopping idle sandbox");
        await this.docker.request("POST", `/containers/${name}/stop?t=5`).catch(() => {});
      } else if (c.State !== "running" && idle > this.config.idleRemoveMs) {
        this.log.info({ name }, "removing idle sandbox");
        await this.docker.request("DELETE", `/containers/${name}?force=true`).catch(() => {});
        this.usage.delete(name);
      }
    }
  }
}
