// The member socket client: connect with a one-use ticket, route server
// frames to handlers, and resync the open thread on every reconnect.

import type { ServerFrame } from "@guild/wire/types";
import { parseServerFrame, serializeClientFrame } from "@guild/wire/parse";

import { SessionExpiredError, mintTicket, refreshSession, wsUrl } from "./session";
import { clientId } from "./machine-rpc";
import { StreamEvent, ThreadEventRow, ThreadState } from "./thread-events";
import { ChatSubagentNode, ChatSummary } from "./api/chats";
import type { Project } from "./api/projects";
import type { MachineInfo } from "./api/machines";

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
  onOrgEvent?: (event: unknown) => void;
  /** The workspace's display identity (name, logo), sent with every
   *  workspace push and on every rename. */
  onWorkspaceIdentity?: (identity: { name: string; logo_url?: string }) => void;
}

/** Converts the current HTTP origin into the WebSocket origin. */

export function openSocket(url: string, factory: SocketFactory = (u) => new WebSocket(u)): SocketLike {
  return factory(url);
}

/** Never hand an empty message to the UI: a blank toast tells the user nothing. */
function reportError(error: unknown, handlers: SocketHandlers): void {
  const message = error instanceof Error ? error.message : String(error);
  handlers.onError?.(message.trim() === "" ? "Could not reach the server" : message);
}

/** Pure protocol router. It has no browser or socket dependencies. */

export function routeMessage(message: ServerFrame, handlers: SocketHandlers): void {
  switch (message.type) {
    case "hello":
    case "tool_dispatch":
    case "tool_cancel":
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
    case "workspace_identity":
      handlers.onWorkspaceIdentity?.({ name: message.name, logo_url: message.logo_url });
      return;
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
  let pingsTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  const noteFrame = (): void => {
    lastFrameAt = Date.now();
  };
  const livenessLoop = (): void => {
    if (pingsTimer !== null) return;
    pingsTimer = setInterval(() => {
      if (stopped) return;
      if (socket?.readyState === 1) {
        try { socket.send(serializeClientFrame({ type: "ping" })); } catch { /* closing */ }
      }
    }, PING_INTERVAL_MS);
    watchdogTimer = setInterval(() => {
      if (stopped || socket === null || socket.readyState !== 1) return;
      if (lastFrameAt !== 0 && Date.now() - lastFrameAt > DEAD_AFTER_MS) {
        // Half-open black hole: force the reconnect path (onclose fires).
        try { socket.close(); } catch { /* already closing */ }
      }
    }, 2_000);
  };
  const livenessStop = (): void => {
    if (pingsTimer !== null) { clearInterval(pingsTimer); pingsTimer = null; }
    if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
  };

  const sendSync = () => {
    if (socket?.readyState !== 1) return;
    socket.send(serializeClientFrame({ type: "sync", chat_id: opts.getOpenChatId() }));
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null || connecting) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  };
  const connect = async (): Promise<void> => {
    if (stopped || connecting) return;
    connecting = true;
    try {
      if (needsRefresh) { await refreshSession(); needsRefresh = false; }
      const ticket = await mintTicket();
      if (stopped) return;
      const url = `${wsUrl()}/api/v1/ws?ticket=${encodeURIComponent(ticket)}&client_id=${encodeURIComponent(clientId())}`;
      const current = openSocket(url, factory);
      socket = current;
      current.onopen = () => {
        if (socket !== current || stopped) return;
        viewWatermarks.clear();
        noteFrame();
        opts.onConnect?.();
        sendSync();
      };
      current.onmessage = (event) => {
        if (socket !== current || stopped || typeof event.data !== "string") return;
        noteFrame();
        try {
          // An unknown frame tag is a newer server, not a broken one: ignore
          // it and keep the connection.
          const message = parseServerFrame(event.data);
          if (message === null) return;
          if (message.type === "auth_required") {
            connecting = true;
            needsRefresh = true;
            current.close();
            void refreshSession().then(() => {
              needsRefresh = false;
              connecting = false;
              scheduleReconnect();
            }).catch((error) => {
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
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        scheduleReconnect();
      };
    } catch (error) {
      connecting = false;
      if (error instanceof SessionExpiredError) { stopped = true; opts.onAuthRequired?.(); return; }
      reportError(error, opts);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  livenessLoop();
  // Wake-ups and network flips leave half-open sockets behind: re-check
  // liveness (and resync when healthy) the moment the tab is live again.
  const wakeCheck = (): void => {
    if (stopped) return;
    if (socket === null || socket.readyState !== 1) {
      if (lastFrameAt === 0 || Date.now() - lastFrameAt > DEAD_AFTER_MS) void connect();
    } else if (Date.now() - lastFrameAt > DEAD_AFTER_MS) {
      try { socket.close(); } catch { /* already closing */ }
    } else {
      sendSync();
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", wakeCheck);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wakeCheck();
    });
  }

  void connect();
  return {
    stop: () => {
      stopped = true;
      livenessStop();
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

