import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  ChevronUp,
  Copy,
  Download,
  FileText,
  Laptop,
  Lightbulb,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Cpu,
  Unlink,
  Wrench,
} from "lucide-react";

import { Button } from "@guild/ui/components/button";
import { Card } from "@guild/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Caret } from "@guild/ui/components/caret";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Separator } from "@guild/ui/components/separator";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Spinner } from "@guild/ui/components/spinner";
import { Textarea } from "@guild/ui/components/textarea";
import { useTheme } from "../theme";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { postToolResult } from "../transport";
import {
  bindChat,
  createChat,
  getMessages,
  listChats,
  listMachines,
  listModels,
  streamChat,
  attachGeneration,
  createPairingToken,
  downloadRelease,
  listReleases,
  pairingCode,
  startEventStream,
  type ChatMessage,
  type ChatSummary,
  type MachineInfo,
  type Release,
} from "../transport";

interface ToolBlock {
  callId: string;
  name: string;
  args: string;
  executor: "client" | "server";
  status: "running" | "done" | "error";
  content?: string;
}

interface Block {
  kind: "user" | "text" | "error" | "tool";
  text: string;
  tool?: ToolBlock;
}

/// Client-side tools need the desktop runtime (local files, shell); in a plain
/// browser they stay pending until the server-side timeout releases the turn.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Sentinel for a send stream that ended without a terminal frame: not a
/// user-facing error — the send path converts it into a reattach watch.
class DropError extends Error {}

const SUGGESTIONS = [
  { icon: Lightbulb, title: "Explain a concept", prompt: "Explain how " },
  { icon: FileText, title: "Draft a message", prompt: "Draft a message to " },
  { icon: MessageSquare, title: "Summarize text", prompt: "Summarize the following:\n\n" },
];

const WIDTH_KEY = "guild.sidebarWidth";
const MIN_W = 200;
const MAX_W = 420;

function clampWidth(w: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

/// Shown while a deep-linked thread's messages are in flight (the URL says
/// /thread/<id> but the view has nothing to render yet). Without this, the
/// new-thread hero would flash for the whole fetch duration.
function ThreadSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-8">
      <Spinner />
      <p className="text-sm text-muted-foreground">Loading thread…</p>
    </div>
  );
}

/// Web-mode chat: streaming conversation through the org gateway, with a
/// server-backed conversation list. Full agent mode (local tools + project)
/// is the desktop (Tauri) flow.
export default function WebChat({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false); // /thread/<id> fetch in flight with nothing to show
  const [prompt, setPrompt] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false); // receiving a server-side generation
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop sidebar
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampWidth(stored) : 256;
  });
  const bottom = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const attachAbort = useRef<AbortController | null>(null);
  const loadAbort = useRef<AbortController | null>(null); // in-flight thread-load fetch
  const sendAbort = useRef<AbortController | null>(null); // in-flight send stream
  const loadSeq = useRef(0); // guards against stale thread loads landing last
  const pendingDeepLink = useRef(false); // true while the /thread/<id> from the URL is loading

  // App-lifetime presence connection: the server uses it to detect that
  // this app instance is gone and resolve suspended client tools without
  // waiting for the 5-minute timeout.
  useEffect(() => startEventStream(), []);

  useEffect(() => {
    listModels().then((m) => {
      setModels(m);
      if (m.length > 0) setModel((cur) => cur || m[0]);
    });
    void refreshChats();
  }, []);

  // Deep link: open the thread encoded in the URL (/thread/<id>) on first load.
  useEffect(() => {
    const m = window.location.pathname.match(/^\/thread\/([^/]+)\/?$/);
    if (m) {
      pendingDeepLink.current = true;
      void openChat(decodeURIComponent(m[1])).finally(() => {
        pendingDeepLink.current = false;
      });
    } else {
      window.history.replaceState(null, "", "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in sync with the open thread; back/forward walks thread history.
  useEffect(() => {
    if (pendingDeepLink.current) return;
    const path = chatId ? `/thread/${chatId}` : "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, [chatId]);

  useEffect(() => {
    const onPop = () => popHandler.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [blocks]);

  const refreshChats = async () => setChats(await listChats());

  // latest closure for the popstate handler
  const popHandler = useRef<() => void>(() => {});
  popHandler.current = () => {
    const m = window.location.pathname.match(/^\/thread\/([^/]+)\/?$/);
    if (m) void openChat(decodeURIComponent(m[1]));
    else {
      loadAbort.current?.abort();
      loadAbort.current = null;
      sendAbort.current?.abort();
      sendAbort.current = null;
      attachAbort.current?.abort();
      attachAbort.current = null;
      setChatId(null);
      setBlocks([]);
      setThreadLoading(false);
    }
  };

  const openChat = async (id: string) => {
    if (id === chatId) {
      setOpen(false);
      return;
    }
    setOpen(false);
    // Switching is allowed even mid-generation: the generation runs detached
    // server-side and keeps persisting; the client-side stream is cancelled
    // here and re-attached (with catch-up) when this thread is reopened.
    loadAbort.current?.abort();
    loadAbort.current = new AbortController();
    const loadAc = loadAbort.current;
    sendAbort.current?.abort();
    sendAbort.current = null;
    attachAbort.current?.abort(); // replaced when the new thread's attach starts
    // Stay on the previous thread's content until the new one arrives; the
    // sidebar highlight moves only when chatId is set below.
    const seq = ++loadSeq.current;
    setThreadLoading(true);
    try {
      const msgs: ChatMessage[] = await getMessages(id, loadAc.signal);
      if (seq !== loadSeq.current) return; // a newer thread switch superseded this one
      setBlocks(
        msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ kind: m.role === "user" ? "user" : "text", text: m.content }) as Block),
      );
      setChatId(id);
      // A generation may still be running server-side (e.g. it outlived a
      // previous client, or the stream dropped earlier). Attach with
      // automatic reconnection and keep streaming it into the view.
      const attachSeq = seq;
      const ac = new AbortController();
      attachAbort.current?.abort();
      attachAbort.current = ac;
      void watchGeneration(id, attachSeq, ac);
    } catch {
      // aborted (a newer switch superseded this one) or a real error — either
      // way leave the previous thread on screen; switching is non-destructive
    } finally {
      // only the load that is still current may clear the flag; a superseded
      // one finishing late must not extinguish a newer load's spinner
      if (seq === loadSeq.current) setThreadLoading(false);
    }
  };

  const newChat = () => {
    // allowed even mid-generation: the server-side generation continues and
    // is re-attachable when the thread is reopened
    loadSeq.current++; // invalidate any in-flight thread load or generation attach
    loadAbort.current?.abort();
    loadAbort.current = null;
    sendAbort.current?.abort();
    sendAbort.current = null;
    attachAbort.current?.abort();
    attachAbort.current = null;
    setChatId(null);
    setBlocks([]);
    setThreadLoading(false);
    setOpen(false);
    ta.current?.focus();
  };

  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  // ---- server-side tool loop support ----

  const executingTools = useRef<Set<string>>(new Set());
  const workDirRef = useRef<string | null>(null);

  /// Handles tool lifecycle events from either stream (send or attach):
  /// renders the tool chip and, for client-executed tools in the desktop
  /// runtime, runs the tool locally and posts the result back.
  const handleToolEvent = (ev: { type: string; [k: string]: unknown }, cid: string, seq: number) => {
    const callId = ev.call_id as string | undefined;
    if (!callId) return;
    if (ev.type === "tool_started") {
      const name = (ev.name as string) ?? "";
      const args = (ev.arguments as string) ?? "{}";
      const executor = ev.executor === "client" ? "client" : "server";
      setBlocks((b) => [
        ...b,
        { kind: "tool", text: "", tool: { callId, name, args, executor, status: "running" } },
      ]);
      if (executor !== "client" || !isTauri) return; // browser: the desktop app would execute this
      if (seq !== loadSeq.current || executingTools.current.has(callId)) return;
      executingTools.current.add(callId);
      void (async () => {
        try {
          let dir = workDirRef.current;
          if (!dir) {
            const picked = await openDialog({ directory: true, multiple: false });
            if (typeof picked !== "string") throw new Error("no workspace folder selected");
            dir = picked;
            workDirRef.current = dir;
          }
          const res = await invoke<any>("rpc_request", {
            method: "tool.run",
            params: { name, args: JSON.parse(args), workdir: dir },
          });
          const payload = res.result ?? res;
          await postToolResult(cid, callId, String(payload.output ?? ""), !!payload.is_error);
        } catch (e) {
          await postToolResult(cid, callId, `client tool failed: ${String(e)}`, true).catch(() => {});
        } finally {
          executingTools.current.delete(callId);
        }
      })();
    } else if (ev.type === "tool_completed") {
      const status: "done" | "error" = ev.is_error ? "error" : "done";
      const content = (ev.content as string) ?? "";
      setBlocks((b) =>
        b.map((x) => {
          const t = x.tool;
          if (x.kind !== "tool" || !t || t.callId !== callId) return x;
          return { kind: "tool", text: "", tool: { ...t, status, content } };
        }),
      );
    }
  };

  /// Watches a chat's server-side generation, reconnecting transparently when
  /// the SSE stream drops (server redeploy, network blip, laptop sleep).
  /// Every (re)connect first reloads the persisted messages — the durable
  /// source of truth — so text streamed before the drop is neither duplicated
  /// nor lost. The attach endpoint ends with `idle` when nothing is running,
  /// `done`/`error` when the turn finished; a stream that ends with neither
  /// is a dropped connection → backoff, reload, reattach. Returns what was
  /// observed so callers can decide on user-facing messaging.
  const watchGeneration = async (
    cid: string,
    seq: number,
    ac: AbortController,
  ): Promise<{ terminal: "done" | "error" | "idle" | "none"; sawContent: boolean }> => {
    setAttaching(true);
    let sawContent = false;
    // holder object: the SSE callbacks mutate this after an await, which a
    // plain `let` cannot express under TS control-flow narrowing
    const term: { v: "done" | "error" | "idle" | "none" } = { v: "none" };
    let lastError: string | null = null;
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        if (seq !== loadSeq.current || ac.signal.aborted) break;
        try {
          // reconcile with durable state before (re)attaching
          const msgs: ChatMessage[] = await getMessages(cid, ac.signal);
          if (seq !== loadSeq.current || ac.signal.aborted) break;
          setBlocks(
            msgs
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ kind: m.role === "user" ? "user" : "text", text: m.content }) as Block),
          );
          term.v = "none";
          // The first delta after attach is the server's catch-up snapshot of
          // the in-flight turn (full buffer, not a delta) — or, when there is
          // no catch-up, the first live delta of that turn. Either way it
          // starts a NEW text block: the reload above restored persisted
          // messages only, so the in-flight turn has no block yet and the
          // last text block belongs to a previous turn. Later deltas append.
          let firstDelta = true;
          await attachGeneration(
            cid,
            (ev) => {
              if (seq !== loadSeq.current) return; // user moved to another thread
              if (ev.type === "delta" && ev.content) {
                sawContent = true;
                const seed = firstDelta;
                firstDelta = false;
                setBlocks((b) => {
                  const last = b[b.length - 1];
                  if (!seed && last?.kind === "text") return [...b.slice(0, -1), { kind: "text", text: last.text + ev.content! }];
                  return [...b, { kind: "text", text: ev.content! }];
                });
              } else if (ev.type === "tool_started" || ev.type === "tool_completed") {
                sawContent = true;
                handleToolEvent(ev, cid, seq);
              } else if (ev.type === "error") {
                lastError = ev.message ?? "model error";
                term.v = "error";
              } else if (ev.type === "done") {
                term.v = "done";
              } else if (ev.type === "idle") {
                term.v = "idle";
              }
            },
            ac.signal,
          );
          // re-read through a widened local: the SSE callbacks may have
          // reassigned term.v after the await, which TS narrowing can't see
          const outcome = term.v as "done" | "error" | "idle" | "none";
          if (outcome === "idle") {
            // the generation may have completed between the reload and the
            // attach; reload once more so the final message is on screen
            try {
              const final: ChatMessage[] = await getMessages(cid, ac.signal);
              if (seq === loadSeq.current) {
                setBlocks(
                  final
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .map((m) => ({ kind: m.role === "user" ? "user" : "text", text: m.content }) as Block),
                );
              }
            } catch {
              /* keep what we have */
            }
            break;
          }
          if (outcome !== "none") break; // done / error: real end
          // no terminal frame → dropped connection; fall through to backoff
        } catch {
          /* network error while loading or attaching → retry */
        }
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
      }
    } finally {
      if (attachAbort.current === ac) {
        attachAbort.current = null;
        setAttaching(false);
      }
    }
    if (term.v === "error" && lastError !== null) {
      // (kept as-is: reached only when the loop broke on an error frame)
      setBlocks((b) => [...b, { kind: "error", text: lastError! }]);
    }
    return { terminal: term.v as "done" | "error" | "idle" | "none", sawContent };
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy || !model) return;
    const mySeq = loadSeq.current; // switching away mid-send cancels the client stream
    setBusy(true);
    setPrompt("");
    if (ta.current) ta.current.style.height = "auto";
    setBlocks((b) => [...b, { kind: "user", text }]);
    let cid = chatId;
    if (!cid) {
      cid = await createChat(text.slice(0, 48));
      if (cid && loadSeq.current === mySeq) {
        setChatId(cid);
        void refreshChats();
      }
    }
    if (!cid) {
      if (loadSeq.current === mySeq) {
        setBlocks((b) => [...b, { kind: "error", text: "chat create failed" }]);
      }
      setBusy(false);
      return;
    }
    const ac = new AbortController();
    sendAbort.current = ac;
    try {
      let gotDone = false;
      await streamChat(
        cid,
        model,
        text,
        (ev) => {
          if (loadSeq.current !== mySeq) return; // user switched away mid-generation
          if (ev.type === "done") {
            gotDone = true;
            return;
          }
          if (ev.type === "delta" && ev.content) {
            // deltas are per model turn; every tool call emits tool_started,
            // so a tool block always separates turns — append to the current
            // text block, or start a new one after a tool block
            setBlocks((b) => {
              const last = b[b.length - 1];
              if (last?.kind === "text") return [...b.slice(0, -1), { kind: "text", text: last.text + ev.content! }];
              return [...b, { kind: "text", text: ev.content! }];
            });
          } else if (ev.type === "tool_started" || ev.type === "tool_completed") {
            handleToolEvent(ev, cid, mySeq);
          } else if (ev.type === "error") {
            setBlocks((b) => [...b, { kind: "error", text: ev.message ?? "model error" }]);
          }
        },
        ac.signal,
      );
      if (!gotDone) {
        // stream ended without a terminal frame: the connection dropped while
        // the durable generation keeps running server-side — watch it instead
        // of surfacing a dead "network error"
        throw new DropError();
      }
      void refreshChats();
    } catch (e) {
      if (loadSeq.current !== mySeq) return; // deliberate switch away, not an error
      setBusy(false);
      if (sendAbort.current === ac) sendAbort.current = null;
      const wac = new AbortController();
      attachAbort.current?.abort();
      attachAbort.current = wac;
      const r = await watchGeneration(cid, mySeq, wac);
      if (r.terminal === "done") {
        void refreshChats();
      } else if (r.terminal === "idle" && !r.sawContent) {
        setBlocks((b) => [
          ...b,
          { kind: "error", text: "connection dropped before the reply started — try sending again" },
        ]);
      } else if (r.terminal === "none") {
        setBlocks((b) => [
          ...b,
          {
            kind: "error",
            text: "lost connection and could not reattach — the reply may still arrive; reopen this thread to catch up",
          },
        ]);
      }
      return;
    } finally {
      setBusy(false);
      if (sendAbort.current === ac) sendAbort.current = null;
    }
  };

  const activeTitle =
    threadLoading && blocks.length === 0
      ? "Loading…"
      : (chats?.find((c) => c.id === chatId)?.title ?? "New chat");
  const boundMachine = chats?.find((c) => c.id === chatId)?.machine_label ?? null;
  const streaming = busy || attaching;

  const sidebar = (
    <SidebarContent
      chats={chats}
      chatId={chatId}
      email={email}
      onNewChat={newChat}
      onOpenChat={openChat}
      onSignOut={onSignOut}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenDevice={() => setDeviceOpen(true)}
    />
  );

  // desktop: draggable resize handle
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const move = (ev: MouseEvent) => {
        const w = clampWidth(startW + ev.clientX - startX);
        setWidth(w);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        setWidth((w) => {
          localStorage.setItem(WIDTH_KEY, String(w));
          return w;
        });
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [width],
  );

  return (
    <div className="fixed inset-0 flex bg-background text-foreground">
      {/* desktop sidebar: resizable + collapsible; mobile: drawer */}
      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Chats</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>
      ) : (
        !collapsed && (
          <aside
            className="relative flex shrink-0 flex-col border-r border-border bg-card"
            style={{ width }}
          >
            {sidebar}
            <div
              className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-ring"
              onMouseDown={startDrag}
              title="Drag to resize"
            />
          </aside>
        )
      )}

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-sm">
          {isMobile ? (
            <Button variant="ghost" size="icon" className="-ml-1.5 size-8" onClick={() => setOpen(true)}>
              <Menu />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-1.5 size-8 text-muted-foreground"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? "Open sidebar" : "Close sidebar"}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{activeTitle}</span>
          {boundMachine && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              title={`Machine tools run on: ${boundMachine}`}
            >
              <Cpu className="size-3" />
              {boundMachine}
            </span>
          )}
        </header>

        {blocks.length === 0 ? (
          threadLoading ? (
            <ThreadSkeleton />
          ) : (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-card">
              <Bot className="size-7 text-muted-foreground" />
            </div>
            <h1 className="mt-6 text-center text-2xl font-semibold tracking-tight">What should we work on?</h1>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Chat with the org gateway
              {models !== null && models.length === 0 ? " — no models configured yet" : ""}.
            </p>
            <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <Card
                  key={s.title}
                  className="cursor-pointer gap-2 px-4 py-4 transition-colors hover:bg-accent"
                  onClick={() => {
                    setPrompt(s.prompt);
                    ta.current?.focus();
                  }}
                >
                  <s.icon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{s.title}</span>
                </Card>
              ))}
            </div>
            {models !== null && models.length === 0 && (
              <p className="mt-8 rounded-md border border-amber-700/60 bg-amber-900/30 px-3 py-1.5 text-xs text-amber-300">
                no models configured — ask an admin to add a route
              </p>
            )}
          </div>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
              {blocks.map((b, i) =>
                b.kind === "user" ? (
                  <div
                    key={i}
                    className="ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-sm"
                  >
                    {b.text}
                  </div>
                ) : b.kind === "tool" && b.tool ? (
                  <div key={i} className="mr-auto w-fit max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 font-mono text-amber-600 dark:text-amber-400">
                      <Wrench className="size-3.5" /> {b.tool.name}
                      <span className="text-muted-foreground">· {b.tool.executor}</span>
                      {b.tool.status === "running" && (
                        <span className="animate-pulse text-muted-foreground">running…</span>
                      )}
                    </span>
                    <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
                      {b.tool.args}
                    </pre>
                    {b.tool.status !== "running" && b.tool.content && (
                      <pre
                        className={
                          "mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap " +
                          (b.tool.status === "error" ? "text-destructive" : "text-muted-foreground")
                        }
                      >
                        {b.tool.content}
                      </pre>
                    )}
                  </div>
                ) : b.kind === "error" ? (
                  <div
                    key={i}
                    className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {b.text}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="max-w-none space-y-2 text-sm leading-relaxed [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1,\&_h2,\&_h3]:text-base [&_h1,\&_h2,\&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[0.85em] [&_pre_[code]]:bg-transparent [&_pre_[code]]:p-0 [&_ul]:list-disc"
                  >
                    <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
                    {streaming && i === blocks.length - 1 && <Caret className="mt-1" />}
                  </div>
                ),
              )}
              {/* caret only while reply text is actually streaming; tool
                  blocks have their own status, silence shows nothing */}
              {streaming && blocks.length === 0 && (
                <div className="max-w-none text-sm">
                  <Caret />
                </div>
              )}
              <div ref={bottom} />
            </div>
          </div>
        )}

        {/* composer */}
        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
          <div className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card p-2 shadow-sm">
            <Textarea
              ref={ta}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={models === null || model ? "Message Guild…" : "No model available"}
              disabled={streaming || (models !== null && !model)}
              className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none "
            />
            <div className="flex items-center justify-between gap-2 px-1 pt-1">
              {models === null ? (
                <Skeleton className="h-7 w-28 rounded-md" />
              ) : models.length === 0 ? (
                <span className="text-xs text-muted-foreground">no models</span>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {models !== null && models.length > 0 && (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="h-7 w-auto gap-1 border-none bg-secondary px-2 text-xs shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m} className="text-xs">
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="icon"
                  className="size-7 rounded-full"
                  onClick={() => void send()}
                  disabled={busy || !model || !prompt.trim()}
                  title="Send"
                >
                  {busy ? <Spinner className="text-primary-foreground" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DeviceSetupDialog open={deviceOpen} onOpenChange={setDeviceOpen} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        email={email}
        chatId={chatId}
        currentMachineId={chats?.find((c) => c.id === chatId)?.machine_id ?? null}
        onMachineChanged={() => void refreshChats()}
      />
    </div>
  );
}

/// "Set up a device": explains why the desktop app exists, lists installers
/// with the visitor's OS preselected, and issues a pairing code.
type DesktopOs = "mac" | "windows" | "linux";

function detectOs(): DesktopOs {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

const OS_KEY: Record<DesktopOs, string> = { mac: "darwin", windows: "windows", linux: "linux" };

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const OS_LABEL: Record<DesktopOs, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

function platformLabel(platform: string): string {
  if (platform === "darwin-aarch64") return "Mac — Apple Silicon";
  if (platform === "darwin-x86_64") return "Mac — Intel";
  if (platform === "windows-x86_64") return "Windows — 64-bit";
  if (platform === "linux-x86_64") return "Linux — 64-bit";
  if (platform === "linux-aarch64") return "Linux — ARM64";
  return platform;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function DeviceSetupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [os, setOs] = useState<DesktopOs>("linux");
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairCopied, setPairCopied] = useState(false);
  const [dlBusy, setDlBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOs(detectOs());
    setReleases(null);
    setPairCode(null);
    listReleases().then((r) => {
      const desktop = r.filter((x) => x.kind === "desktop");
      // show only the latest version's installers, one per platform
      const latest = desktop.reduce<string | null>(
        (acc, x) => (acc === null || compareVersions(x.version, acc) > 0 ? x.version : acc),
        null,
      );
      setReleases(latest === null ? desktop : desktop.filter((x) => x.version === latest));
    });
  }, [open]);

  const installers =
    releases === null ? null : releases.filter((r) => r.platform.startsWith(OS_KEY[os]));

  const generatePairing = () => {
    setPairBusy(true);
    createPairingToken(30)
      .then((t) => setPairCode(pairingCode(window.location.origin, t.secret)))
      .finally(() => setPairBusy(false));
  };

  const startDownload = (r: Release) => {
    setDlBusy(r.id);
    downloadRelease(r.id)
      .catch(() => {})
      .finally(() => setDlBusy(null));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up a device</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 text-left">
          <p className="text-sm text-muted-foreground">
            The desktop app runs a Guild agent on your machine — it can work directly in your
            projects and with your files, which the browser chat can't. Chat alone stays right here.
          </p>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">1. Download app</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(Object.keys(OS_KEY) as DesktopOs[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setOs(k)}
                  className={`rounded-md px-2 py-1.5 text-xs outline-none transition-colors ${
                    os === k
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {OS_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="mt-2 min-w-0 space-y-2">
              {installers === null && [0, 1].map((i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
              {installers !== null && installers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No {OS_LABEL[os]} installer published yet — check back soon.
                </p>
              )}
              {installers?.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={r.filename}>
                      {platformLabel(r.platform)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      v{r.version} · {formatSize(r.size_bytes)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => startDownload(r)} disabled={dlBusy === r.id}>
                    <Download /> {dlBusy === r.id ? "…" : "Download"}
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">2. Pair with your account</p>
            {pairCode ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs"
                    title={pairCode}
                  >
                    {pairCode}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(pairCode);
                      setPairCopied(true);
                      setTimeout(() => setPairCopied(false), 1500);
                    }}
                  >
                    <Copy /> {pairCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Paste into the desktop app's pairing screen. Single-use, expires in 30 minutes.
                </p>
              </div>
            ) : (
              <Button size="sm" onClick={generatePairing} disabled={pairBusy}>
                {pairBusy ? "Generating…" : "Generate pairing code"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  email,
  chatId,
  currentMachineId,
  onMachineChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  chatId: string | null;
  currentMachineId: string | null;
  onMachineChanged: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const [machines, setMachines] = useState<MachineInfo[] | null>(null);
  useEffect(() => {
    if (open) void listMachines().then(setMachines);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 text-left">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Appearance</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(["dark", "light", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`rounded-md px-2 py-1.5 text-xs capitalize outline-none transition-colors ${
                    theme === t
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Account</p>
            <p className="text-sm">{email}</p>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Machine</p>
            {!chatId ? (
              <p className="text-xs text-muted-foreground">Open a chat to bind it to a machine.</p>
            ) : machines && machines.length > 0 ? (
              <div className="flex flex-col gap-1">
                {machines.map((m) => (
                  <button
                    key={m.machine_id}
                    onClick={async () => {
                      await bindChat(chatId, m.machine_id);
                      onMachineChanged();
                    }}
                    className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-xs outline-none transition-colors ${
                      currentMachineId === m.machine_id
                        ? "border-foreground/30 bg-card text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{m.name}</span>
                    {currentMachineId === m.machine_id ? (
                      <span className="text-[10px] uppercase tracking-wide">bound</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">use</span>
                    )}
                  </button>
                ))}
                {currentMachineId && (
                  <button
                    onClick={async () => {
                      await bindChat(chatId, null);
                      onMachineChanged();
                    }}
                    className="flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground"
                  >
                    <Unlink className="size-3" /> unbind machine
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No machines connected. Start the Guild desktop app on the machine you want
                agent tools to run on.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/// Sidebar conversation item. The pill always fits the sidebar (padding on
/// both sides); an overflowing title is faded out at the right edge instead
/// of hard-clipped, and only when it actually overflows.
function ChatListItem({
  title,
  active,
  onClick,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [title]);

  const fade = overflowing
    ? {
        maskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
        WebkitMaskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
      }
    : undefined;

  return (
    <button
      onClick={onClick}
      className={`w-full overflow-hidden rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      }`}
      title={title}
    >
      <span
        ref={ref}
        className="block whitespace-nowrap"
        style={fade}
      >
        {title}
      </span>
    </button>
  );
}

function SidebarContent({
  chats,
  chatId,
  email,
  onNewChat,
  onOpenChat,
  onSignOut,
  onOpenSettings,
  onOpenDevice,
}: {
  chats: ChatSummary[] | null;
  chatId: string | null;
  email: string;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenDevice: () => void;
}) {
  const initials = email.slice(0, 2).toUpperCase();
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold">Guild</span>
      </div>
      <div className="px-2">
        <Button variant="ghost" className="w-full justify-start gap-2 text-sm" onClick={onNewChat}>
          <Plus /> New chat
        </Button>
      </div>
      <div className="px-3 pb-1 pt-4 text-xs font-medium text-muted-foreground">Chats</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5 pb-2">
          {chats === null &&
            [0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          {chats !== null &&
            chats.map((c) => (
              <ChatListItem
                key={c.id}
                title={c.title || "Untitled"}
                active={c.id === chatId}
                onClick={() => onOpenChat(c.id)}
              />
            ))}
          {chats !== null && chats.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet.</p>
          )}
        </div>
      </div>
      <Separator />
      <div className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent"
              title="Account"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {initials}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={email}>
                {email}
              </span>
              <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuItem onClick={onOpenDevice}>
              <Laptop /> Set up a device
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open("/admin/", "_blank")}>
              <ArrowUpRight /> Admin console
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings2 /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
