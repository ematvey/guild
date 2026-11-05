// The member socket client: connect with a one-use ticket, route server
// frames to handlers, and resync the open thread on every reconnect.

import type { ServerFrame } from "@guild/wire/types";
import type {
  Agent,
  AgentRoutine,
  AttachableIntegration,
  AgentRun,
  AgentThread,
  ChatTree,
  EventRow,
  SkillCatalogItem,
  SkillInstall,
  UserInfo,
} from "@guild/wire/rest";
import { parseServerFrame, serializeClientFrame } from "@guild/wire/parse";

import { SessionExpiredError, mintTicket, refreshSession, wsUrl } from "./session";
import { clientId } from "./machine-rpc";
import { traceEvent } from "./telemetry";
import type { StreamEvent, ThreadEventRow, ThreadState } from "./thread-events";
import type { ChatSubagentNode, ChatSummary } from "./api/chats";
import type { Project } from "./api/projects";
import type { MachineInfo } from "./api/machines";
import type { ModelOption } from "./api/models";
import type { WorkspaceIdentity } from "./workspace-store";
import type { ContextUsage } from "./context-usage-store";

export interface SocketLike {
  readonly readyState: number;
  onopen: ((event?: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event?: any) => void) | null;
  onclose: ((event?: any) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SocketHandlers {
  onConnect?: () => void;
  onThreadState?: (state: ThreadState) => void;
  /** Incremental durable-log fan-out: rows appended since the client's
   *  last view, rendered through the same replay rules a sync uses. */
  onThreadEvents?: (chat_id: string, seq: number, events: ThreadEventRow[]) => void;
  /** The open chat's thread subtree with each node's latest run status. */
  onSubagentTree?: (chat_id: string, nodes: ChatSubagentNode[]) => void;
  onThreadList: (chats: ChatSummary[]) => void;
  /** One active-list row changed in place (sent instead of the whole list
   *  to a socket that declared `chat_row`). */
  onChatRow?: (chat: ChatSummary) => void;
  /** One chat's context usage (its sync bracket, then every change). */
  onContextUsage?: (chatId: string, usage: ContextUsage) => void;
  /** The archived chats list, sent with every workspace push. */
  onArchivedThreadList?: (chats: ChatSummary[]) => void;
  /** Active and archived projects, sent with every workspace push. */
  onProjectList?: (projects: Project[], archived: Project[]) => void;
  /** The machine registry rows, sent with every workspace push. */
  onMachineList?: (machines: MachineInfo[]) => void;
  /** One machine's socket presence flip (claimed or released). */
  onMachineStatus?: (machine_id: string, online: boolean) => void;
  onChatStatus: (frame: { chat_id: string; generating: boolean }) => void;
  onFrame: (frame: { chat_id: string; machine_id: string | null; event: StreamEvent }) => void;
  onSync: (chat_id: string, phase: "begin" | "done") => void;
  onDisplaced?: () => void;
  onAuthRequired?: () => void;
  onError?: (message: string) => void;
  /** One org event row (skill registry and install activity). */
  onOrgEvent?: (event: EventRow) => void;
  /** Every agent the member may see. */
  onAgentList?: (agents: Agent[]) => void;
  /** The Integrations the member may add to an agent. */
  onIntegrationAccess?: (integrations: AttachableIntegration[]) => void;
  /** One run, created or changed. */
  onAgentRun?: (run: AgentRun) => void;
  /** The member's open threads with one agent. */
  onAgentThreads?: (agent_id: string, threads: AgentThread[]) => void;
  /** One agent's routines with their newest runs. */
  onAgentRoutines?: (agent_id: string, routines: AgentRoutine[]) => void;
  /** The org skill catalog plus the member's own installs. */
  onSkillCatalog?: (items: SkillCatalogItem[], installs: SkillInstall[]) => void;
  /** One chat's tree facts for its header. */
  onChatTree?: (tree: ChatTree) => void;
  /** The workspace's identity (name, logo, telemetry switch, served web
   *  bundle), sent with every workspace push and on every change. */
  onWorkspaceIdentity?: (identity: WorkspaceIdentity) => void;
  /** The org's enabled models, sent with every workspace push and on every
   *  route change. */
  onModelList?: (models: ModelOption[]) => void;
  /** The member's own account, sent with every workspace push and on every
   *  change to its role, name, avatar or onboarding flag. */
  onMemberProfile?: (user: UserInfo) => void;
}

/** Optional server frames this client applies: one changed chat-list row
 *  instead of the whole list. */
export const SOCKET_FEATURES = "chat_row";

/** Converts the current HTTP origin into the WebSocket origin. */

/** The wait before redial number `failures` (0-based): exponential from
 *  1 s to a 30 s cap with full jitter, so tabs that lost the same server do
 *  not redial it in lockstep. `random` is in [0, 1). */
export function reconnectDelayMs(failures: number, random: number): number {
  const cap = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
  return Math.max(250, Math.floor(random * cap));
}

export function openSocket(url: string, factory: SocketFactory = (u) => new WebSocket(u)): SocketLike {
  return factory(url);
}

const UNREACHABLE = "Can't reach the server — reconnecting";

/** Never hand an empty message or a raw network failure to the UI: fetch
 *  rejects an unreachable host with a TypeError ("Failed to fetch", "Load
 *  failed"), which tells the user nothing. */
function reportError(error: unknown, handlers: SocketHandlers): void {
  if (error instanceof TypeError) {
    handlers.onError?.(UNREACHABLE);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  handlers.onError?.(message.trim() === "" ? UNREACHABLE : message);
}

/** Pure protocol router. It has no browser or socket dependencies. */

export function routeMessage(message: ServerFrame, handlers: SocketHandlers): void {
  switch (message.type) {
    // Connection and liveness frames: the socket's onmessage already noted
    // the frame for the watchdog. Tool dispatch and machine requests belong
    // to the machine socket, never the member socket.
    case "hello":
    case "pong":
    case "tool_dispatch":
    case "tool_cancel":
    case "machine_request":
      return;
    case "thread_state":
      handlers.onThreadState?.(message);
      return;
    case "thread_events":
      handlers.onThreadEvents?.(message.chat_id, message.seq, message.events);
      return;
    case "thread_list":
      handlers.onThreadList(message.chats);
      return;
    case "archived_thread_list":
      handlers.onArchivedThreadList?.(message.chats);
      return;
    case "project_list":
      handlers.onProjectList?.(message.projects, message.archived_projects);
      return;
    case "machine_list":
      handlers.onMachineList?.(message.machines);
      return;
    case "machine_status":
      handlers.onMachineStatus?.(message.machine_id, message.online);
      return;
    case "subagent_tree":
      handlers.onSubagentTree?.(message.chat_id, message.nodes);
      return;
    case "chat_status":
      handlers.onChatStatus({ chat_id: message.chat_id, generating: message.generating });
      return;
    case "sync_begin":
      handlers.onSync(message.chat_id, "begin");
      return;
    case "live_frame":
      handlers.onFrame({ chat_id: message.chat_id, machine_id: message.machine_id ?? null, event: message.event });
      return;
    case "sync_done":
      handlers.onSync(message.chat_id, "done");
      return;
    case "displaced":
      handlers.onDisplaced?.();
      return;
    case "auth_required":
      handlers.onAuthRequired?.();
      return;
    case "error":
      handlers.onError?.(message.message);
      return;
    case "org_event":
      handlers.onOrgEvent?.(message.event);
      return;
    case "agent_list":
      handlers.onAgentList?.(message.agents);
      return;
    case "integration_access":
      handlers.onIntegrationAccess?.(message.integrations);
      return;
    case "agent_run":
      handlers.onAgentRun?.(message.run);
      return;
    case "agent_threads":
      handlers.onAgentThreads?.(message.agent_id, message.threads);
      return;
    case "agent_routines":
      handlers.onAgentRoutines?.(message.agent_id, message.routines);
      return;
    case "skill_catalog":
      handlers.onSkillCatalog?.(message.items, message.installs);
      return;
    case "chat_tree":
      handlers.onChatTree?.(message.tree);
      return;
    case "workspace_identity": {
      const { type: _type, ...identity } = message;
      handlers.onWorkspaceIdentity?.(identity);
      return;
    }
    case "model_list":
      handlers.onModelList?.(message.models);
      return;
    case "member_profile":
      handlers.onMemberProfile?.(message.user);
      return;
    case "chat_row":
      handlers.onChatRow?.(message.chat);
      return;
    case "context_usage":
      handlers.onContextUsage?.(message.chat_id, {
        tokens: message.tokens,
        usage_model: message.usage_model,
        usage_model_alias: message.usage_model_alias,
      });
      return;
    default: {
      // A new frame variant must get a route here before it compiles.
      const unrouted: never = message;
      void unrouted;
    }
  }
}

/** One member socket per tab or desktop webview. Reconnects always resync. */

export function startSocket(
  opts: SocketHandlers & {
    getOpenChatId: () => string | null;
    socketFactory?: SocketFactory;
  },
): { stop: () => void; resync: () => void; markRead: (chatId: string) => boolean } {
  const factory = opts.socketFactory ?? ((url: string) => openSocket(url));
  let socket: SocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connecting = false;
  let needsRefresh = false;
  const viewWatermarks = new Map<string, number>();
  // Liveness: browsers auto-pong protocol-level pings below JS, so the tab
  // cannot hear the server's heartbeat. This side sends app-level pings and
  // watches for ANY server frame back — a stalled tunnel (half-open socket)
  // looks "open" but delivers nothing; without this watchdog the tab stays
  // deaf until an external event kills the connection.
  const PING_INTERVAL_MS = 5_000;
  const DEAD_AFTER_MS = 15_000;
  let lastFrameAt = 0;
  // Diagnostics: which connect attempt this socket is, and when it opened.
  // The trace is how a dropped link is explained after the fact (the switch
  // is the org's; see telemetry.ts).
  let attempt = 0;
  /** Dials since the last connection that delivered a frame: the reconnect
   *  delay grows with it. */
  let failures = 0;
  let openedAt = 0;
  let pingsTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  const noteFrame = (): void => {
    lastFrameAt = Date.now();
  };
  const silentMs = (): number => (lastFrameAt === 0 ? -1 : Date.now() - lastFrameAt);
  const livenessLoop = (): void => {
    if (pingsTimer !== null) return;
    pingsTimer = setInterval(() => {
      if (stopped) return;
      if (socket?.readyState === 1) {
        try {
          socket.send(serializeClientFrame({ type: "ping" }));
        } catch {
          /* closing */
        }
      }
    }, PING_INTERVAL_MS);
    watchdogTimer = setInterval(() => {
      if (stopped || socket === null || socket.readyState !== 1) return;
      // A hidden tab is throttled by the browser, not dead: its app-level
      // pings drop to one a minute, so the silence here is the tab, not the
      // link. The wake check owns the return to visibility.
      if (typeof document !== "undefined" && document.hidden) return;
      if (lastFrameAt !== 0 && Date.now() - lastFrameAt > DEAD_AFTER_MS) {
        traceEvent("socket.watchdog_close", { attempt, silentMs: silentMs() });
        // Half-open black hole: force the reconnect path (onclose fires).
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }
    }, 2_000);
  };
  const livenessStop = (): void => {
    if (pingsTimer !== null) {
      clearInterval(pingsTimer);
      pingsTimer = null;
    }
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const sendSync = () => {
    if (socket?.readyState !== 1) return;
    const chatId = opts.getOpenChatId();
    traceEvent("socket.sync_sent", { attempt, chat: chatId ?? "-" });
    socket.send(serializeClientFrame({ type: "sync", chat_id: chatId }));
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null || connecting) return;
    const delay = reconnectDelayMs(failures, Math.random());
    failures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };
  const connect = async (): Promise<void> => {
    if (stopped || connecting) return;
    // A wake-up can dial while a scheduled reconnect is pending: this attempt
    // is the reconnect, so the timer must not dial a second one.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connecting = true;
    attempt += 1;
    traceEvent("socket.connect_start", { attempt, silentMs: silentMs() });
    try {
      if (needsRefresh) {
        await refreshSession();
        needsRefresh = false;
      }
      const ticket = await mintTicket();
      if (stopped) return;
      // `features` names the optional frames this client applies.
      const url = `${wsUrl()}/api/v1/ws?ticket=${encodeURIComponent(ticket)}&client_id=${encodeURIComponent(clientId())}&features=${SOCKET_FEATURES}`;
      // One live socket per connection: a prior one still open (a half-open
      // socket a wake-up gave up on) is detached first, so its late frames
      // and its close cannot reach this connection.
      const prior = socket;
      socket = null;
      if (prior !== null) {
        try {
          prior.close();
        } catch {
          /* already closing */
        }
      }
      const current = openSocket(url, factory);
      socket = current;
      current.onopen = () => {
        if (socket !== current || stopped) return;
        openedAt = Date.now();
        traceEvent("socket.open", { attempt });
        viewWatermarks.clear();
        noteFrame();
        opts.onConnect?.();
        sendSync();
      };
      current.onmessage = (event) => {
        if (socket !== current || stopped || typeof event.data !== "string") return;
        noteFrame();
        failures = 0;
        try {
          // An unknown frame tag is a newer server, not a broken one: ignore
          // it and keep the connection.
          const message = parseServerFrame(event.data);
          if (message === null) return;
          if (message.type === "auth_required") {
            connecting = true;
            needsRefresh = true;
            traceEvent("socket.auth_required", { attempt });
            current.close();
            void refreshSession()
              .then(() => {
                needsRefresh = false;
                connecting = false;
                scheduleReconnect();
              })
              .catch((error) => {
                connecting = false;
                if (error instanceof SessionExpiredError) {
                  stopped = true;
                  opts.onAuthRequired?.();
                } else {
                  reportError(error, opts);
                  scheduleReconnect();
                }
              });
            return;
          }
          if (message.type === "thread_state") {
            if (message.seq <= (viewWatermarks.get(message.chat_id) ?? -1)) return;
            viewWatermarks.set(message.chat_id, message.seq);
          }
          routeMessage(message, opts);
        } catch {
          /* malformed server message — ignore */
        }
      };
      current.onerror = () => {
        current.close();
      };
      current.onclose = (event?: { code?: number; reason?: string }) => {
        if (socket !== current) return;
        traceEvent("socket.close", {
          attempt,
          code: event?.code ?? -1,
          reason: (event?.reason ?? "").slice(0, 80),
          lifeMs: openedAt === 0 ? -1 : Date.now() - openedAt,
          silentMs: silentMs(),
        });
        socket = null;
        scheduleReconnect();
      };
    } catch (error) {
      connecting = false;
      traceEvent("socket.connect_failed", {
        attempt,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      });
      if (error instanceof SessionExpiredError) {
        stopped = true;
        opts.onAuthRequired?.();
        return;
      }
      reportError(error, opts);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  livenessLoop();
  // Wake-ups and network flips leave half-open sockets behind: re-check
  // liveness the moment the tab is live again. A dead link reconnects (the
  // reconnect resyncs); a stale one — silent past two ping intervals, so a
  // throttled background tab may have stopped hearing it — is probed and
  // resynced; a link that delivered a frame since is current and only
  // probed, since an open socket loses no frame.
  const STALE_AFTER_MS = 2 * PING_INTERVAL_MS;
  const probe = (): void => {
    try {
      socket?.send(serializeClientFrame({ type: "ping" }));
    } catch {
      /* closing */
    }
  };
  const wakeCheck = (): void => {
    if (stopped) return;
    if (socket === null || socket.readyState !== 1) {
      if (lastFrameAt === 0 || Date.now() - lastFrameAt > DEAD_AFTER_MS) void connect();
    } else if (Date.now() - lastFrameAt > DEAD_AFTER_MS) {
      traceEvent("socket.wake_close", { attempt, silentMs: silentMs() });
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    } else if (Date.now() - lastFrameAt > STALE_AFTER_MS) {
      probe();
      sendSync();
    } else {
      probe();
    }
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") wakeCheck();
  };
  const watchWake = typeof window !== "undefined" && typeof document !== "undefined";
  if (watchWake) {
    window.addEventListener("online", wakeCheck);
    document.addEventListener("visibilitychange", onVisibility);
  }

  void connect();
  return {
    stop: () => {
      stopped = true;
      livenessStop();
      if (watchWake) {
        window.removeEventListener("online", wakeCheck);
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      current?.close();
    },
    resync: () => sendSync(),
    // The duplex read-mark: rides the member socket the turn's frames
    // already arrive on — no separate HTTP request per new content. Returns
    // whether the frame left the socket, so the caller retries a dropped
    // mark instead of clearing the dot for a write that never happened.
    markRead: (chatId: string): boolean => {
      if (socket?.readyState !== 1) return false;
      try {
        socket.send(serializeClientFrame({ type: "read", chat_id: chatId }));
        return true;
      } catch {
        return false;
      }
    },
  };
} // shared with the settings window client code
