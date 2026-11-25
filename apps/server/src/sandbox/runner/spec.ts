// The sandbox container policy. Everything security-relevant is fixed here
// from runner config; a request contributes only the sandbox key and the
// workspace subpath, both validated.

import { createHash } from "node:crypto";

export interface RunnerConfig {
  port: number;
  token: string;
  dockerSocket: string;
  /** The guild_data mount inside the runner (subpath dirs are created here). */
  dataDir: string;
  image: string;
  runtime: string;
  /** Docker volume name of guild_data, as the host daemon knows it. */
  volume: string;
  /** The agent workspace volume inside the runner (agent subpath dirs are
   *  created here). */
  agentDataDir: string;
  /** Docker volume name of the agent workspace volume (JuiceFS-backed), as
   *  the host daemon knows it. */
  agentVolume: string;
  /** Docker network for proxied sandboxes, or "none". */
  network: string;
  /** Egress proxy URL handed to proxied sandboxes. */
  proxyUrl: string | null;
  /** Label scoping this runner's containers (the compose project). */
  project: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  tmpSize: string;
  homeSize: string;
  idleStopMs: number;
  idleRemoveMs: number;
  maxRunning: number;
  /** Refuse to run sandboxes on any runtime but runsc unless set. */
  allowRunc: boolean;
}

export const SANDBOX_UID = 1000;
export const WORKSPACE = "/workspace";
/** A tmpfs, not a workspace dir: package installs and caches are bounded and
 *  die with the container, so the workspace holds only the agent's files. */
export const SANDBOX_HOME = "/home/sandbox";
export const AGENT_PATH = "/opt/guild/agent.js";
export const LABEL = "guild.sandbox";

const UUID = "[0-9a-f-]{36}";
const SUBPATH = new RegExp(`^(workspaces|chats)/${UUID}/[A-Za-z0-9_-]{1,64}$`);
const AGENT_SUBPATH = new RegExp(`^agents/${UUID}/${UUID}$`);
const KEY = /^[A-Za-z0-9:_-]{1,200}$/;

export function validSubpath(subpath: string): boolean {
  return SUBPATH.test(subpath) || AGENT_SUBPATH.test(subpath);
}

/** Agent Workspace mounts use the dedicated agent volume. */
export function isAgentSubpath(subpath: string): boolean {
  return subpath.startsWith("agents/");
}

export function validKey(key: string): boolean {
  return KEY.test(key);
}

/** Deterministic container name: one container per (project, key). */
export function containerName(config: Pick<RunnerConfig, "project">, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `guild-sbx-${config.project.replace(/[^a-zA-Z0-9_.-]/g, "-")}-${digest}`;
}

/** The environment every sandbox process sees: package managers write
 *  into the tmpfs home, so no cache or user install reaches the workspace. */
export function sandboxEnv(config: Pick<RunnerConfig, "network" | "proxyUrl">): string[] {
  const env = [
    `HOME=${SANDBOX_HOME}`,
    `GUILD_SANDBOX_CWD=${WORKSPACE}`,
    `PATH=${SANDBOX_HOME}/.local/bin:${SANDBOX_HOME}/.npm-global/bin:${SANDBOX_HOME}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `npm_config_prefix=${SANDBOX_HOME}/.npm-global`,
    `npm_config_cache=${SANDBOX_HOME}/.npm`,
    `npm_config_update_notifier=false`,
    `PYTHONUSERBASE=${SANDBOX_HOME}/.local`,
    `PIP_CACHE_DIR=${SANDBOX_HOME}/.cache/pip`,
    // The image's system site-packages are read-only; --user installs land
    // in the sandbox home, so PEP 668's guard has nothing to protect.
    `PIP_BREAK_SYSTEM_PACKAGES=1`,
    `UV_CACHE_DIR=${SANDBOX_HOME}/.cache/uv`,
    `CARGO_HOME=${SANDBOX_HOME}/.cargo`,
    `XDG_CACHE_HOME=${SANDBOX_HOME}/.cache`,
    `TMPDIR=/tmp`,
  ];
  if (config.network !== "none" && config.proxyUrl !== null) {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      env.push(`${name}=${config.proxyUrl}`);
    }
    env.push("NO_PROXY=localhost,127.0.0.1", "no_proxy=localhost,127.0.0.1");
  }
  return env;
}

/** Docker create body for one sandbox. */
export function containerSpec(config: RunnerConfig, key: string, subpath: string): Record<string, unknown> {
  const source = isAgentSubpath(subpath) ? config.agentVolume : config.volume;
  return {
    Image: config.image,
    Cmd: ["sleep", "infinity"],
    User: `${SANDBOX_UID}:${SANDBOX_UID}`,
    WorkingDir: WORKSPACE,
    Env: sandboxEnv(config),
    Labels: {
      [LABEL]: "1",
      [`${LABEL}.project`]: config.project,
      [`${LABEL}.key`]: key,
      [`${LABEL}.subpath`]: subpath,
    },
    NetworkDisabled: config.network === "none",
    HostConfig: {
      Runtime: config.runtime,
      NetworkMode: config.network,
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": `rw,nosuid,nodev,size=${config.tmpSize},mode=1777`,
        [SANDBOX_HOME]: `rw,nosuid,nodev,size=${config.homeSize},mode=0755,uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: config.pidsLimit,
      Memory: config.memoryBytes,
      MemorySwap: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      Init: true,
      Mounts: [
        {
          Type: "volume",
          Source: source,
          Target: WORKSPACE,
          VolumeOptions: { Subpath: subpath, NoCopy: true },
        },
      ],
      RestartPolicy: { Name: "no" },
    },
  };
}

/** Docker exec body for one agent process. */
export function agentExecSpec(config: Pick<RunnerConfig, "network" | "proxyUrl">): Record<string, unknown> {
  return {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: `${SANDBOX_UID}:${SANDBOX_UID}`,
    WorkingDir: WORKSPACE,
    Env: sandboxEnv(config),
    Cmd: ["node", AGENT_PATH],
  };
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/** The egress proxy by IP address: Docker's embedded DNS does not work
 *  inside gVisor sandboxes, and proxied clients need no DNS of their own. */
function requireProxyUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.GUILD_SANDBOX_PROXY_URL;
  if (!raw) throw new Error("GUILD_SANDBOX_PROXY_URL is required in proxied network mode (http://<egress ip>:3128)");
  const url = new URL(raw);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) {
    throw new Error(
      "GUILD_SANDBOX_PROXY_URL must name the egress proxy by IP address (no DNS inside gVisor sandboxes)",
    );
  }
  return `${url.protocol}//${url.host}`;
}

/** Runner config from env. `project` defaults are filled in by the caller
 *  (discovered from the runner's own compose labels). */
export function loadRunnerConfig(env: NodeJS.ProcessEnv, discovered: { project: string | null }): RunnerConfig {
  const token = env.GUILD_SANDBOX_RUNNER_TOKEN ?? "";
  if (token.length < 16) throw new Error("GUILD_SANDBOX_RUNNER_TOKEN must be set (16+ chars)");
  const project = env.GUILD_SANDBOX_PROJECT ?? discovered.project ?? "guild";
  const networkMode = env.GUILD_SANDBOX_NETWORK_MODE ?? "proxied";
  if (networkMode !== "proxied" && networkMode !== "none") {
    throw new Error("GUILD_SANDBOX_NETWORK_MODE must be proxied or none");
  }
  return {
    port: envInt(env, "GUILD_SANDBOX_RUNNER_PORT", 8090),
    token,
    dockerSocket: env.GUILD_SANDBOX_DOCKER_SOCKET ?? "/var/run/docker.sock",
    dataDir: env.GUILD_SANDBOX_DATA_DIR ?? "/data",
    image: env.GUILD_SANDBOX_IMAGE ?? "guild-sandbox:latest",
    runtime: env.GUILD_SANDBOX_RUNTIME ?? "runsc",
    volume: env.GUILD_SANDBOX_VOLUME ?? `${project}_guild_data`,
    agentDataDir: env.GUILD_SANDBOX_AGENT_DIR ?? "/workspaces",
    agentVolume: env.GUILD_SANDBOX_AGENT_VOLUME ?? `${project}_guild_workspaces`,
    network: networkMode === "none" ? "none" : (env.GUILD_SANDBOX_NETWORK ?? `${project}_sandbox`),
    proxyUrl: networkMode === "none" ? null : requireProxyUrl(env),
    project,
    memoryBytes: envInt(env, "GUILD_SANDBOX_MEMORY_MB", 2048) * 1024 * 1024,
    nanoCpus: Math.round(envInt(env, "GUILD_SANDBOX_CPUS", 2) * 1e9),
    pidsLimit: envInt(env, "GUILD_SANDBOX_PIDS", 512),
    tmpSize: env.GUILD_SANDBOX_TMP_SIZE ?? "1g",
    homeSize: env.GUILD_SANDBOX_HOME_SIZE ?? "512m",
    idleStopMs: envInt(env, "GUILD_SANDBOX_IDLE_STOP_SECONDS", 15 * 60) * 1000,
    idleRemoveMs: envInt(env, "GUILD_SANDBOX_IDLE_REMOVE_SECONDS", 24 * 3600) * 1000,
    maxRunning: envInt(env, "GUILD_SANDBOX_MAX_RUNNING", 32),
    allowRunc: env.GUILD_SANDBOX_ALLOW_RUNC === "1",
  };
}
