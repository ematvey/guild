import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  ChevronUp,
  FileText,
  Lightbulb,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
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
import { ScrollArea } from "@guild/ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Separator } from "@guild/ui/components/separator";
import { Sheet, SheetContent, SheetTitle } from "@guild/ui/components/sheet";
import { Spinner } from "@guild/ui/components/spinner";
import { Textarea } from "@guild/ui/components/textarea";
import { useTheme } from "../theme";
import {
  createChat,
  getMessages,
  listChats,
  listModels,
  streamChat,
  type ChatMessage,
  type ChatSummary,
} from "../transport";

interface Block {
  kind: "user" | "text" | "error";
  text: string;
}

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

/// Web-mode chat: streaming conversation through the org gateway, with a
/// server-backed conversation list. Full agent mode (local tools + project)
/// is the desktop (Tauri) flow.
export default function WebChat({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop sidebar
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampWidth(stored) : 256;
  });
  const bottom = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listModels().then((m) => {
      setModels(m);
      if (m.length > 0) setModel((cur) => cur || m[0]);
    });
    void refreshChats();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [blocks]);

  const refreshChats = async () => setChats(await listChats());

  const openChat = async (id: string) => {
    if (busy || id === chatId) {
      setOpen(false);
      return;
    }
    setLoadingChat(true);
    setOpen(false);
    try {
      const msgs: ChatMessage[] = await getMessages(id);
      setBlocks(
        msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ kind: m.role === "user" ? "user" : "text", text: m.content }) as Block),
      );
      setChatId(id);
    } finally {
      setLoadingChat(false);
    }
  };

  const newChat = () => {
    if (busy) return;
    setChatId(null);
    setBlocks([]);
    setOpen(false);
    ta.current?.focus();
  };

  const autoGrow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy || !model) return;
    setBusy(true);
    setPrompt("");
    if (ta.current) ta.current.style.height = "auto";
    setBlocks((b) => [...b, { kind: "user", text }]);
    let cid = chatId;
    if (!cid) {
      cid = await createChat(text.slice(0, 48));
      if (cid) {
        setChatId(cid);
        void refreshChats();
      }
    }
    if (!cid) {
      setBlocks((b) => [...b, { kind: "error", text: "chat create failed" }]);
      setBusy(false);
      return;
    }
    try {
      let acc = "";
      await streamChat(cid, model, text, (ev) => {
        if (ev.type === "delta" && ev.content) {
          acc += ev.content;
          setBlocks((b) => {
            const last = b[b.length - 1];
            if (last?.kind === "text") return [...b.slice(0, -1), { kind: "text", text: acc }];
            return [...b, { kind: "text", text: acc }];
          });
        } else if (ev.type === "error") {
          setBlocks((b) => [...b, { kind: "error", text: ev.message ?? "model error" }]);
        }
      });
      void refreshChats();
    } catch (e) {
      setBlocks((b) => [...b, { kind: "error", text: String(e instanceof Error ? e.message : e) }]);
    } finally {
      setBusy(false);
    }
  };

  const activeTitle = chats.find((c) => c.id === chatId)?.title ?? "New chat";

  const sidebar = (
    <SidebarContent
      chats={chats}
      chatId={chatId}
      email={email}
      onNewChat={newChat}
      onOpenChat={openChat}
      onSignOut={onSignOut}
      onOpenSettings={() => setSettingsOpen(true)}
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
        </header>

        {blocks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-card">
              <Bot className="size-7 text-muted-foreground" />
            </div>
            <h1 className="mt-6 text-center text-2xl font-semibold tracking-tight">What should we work on?</h1>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Chat with the org gateway{models.length === 0 ? " — no models configured yet" : ""}.
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
            {models.length === 0 && (
              <p className="mt-8 rounded-md border border-amber-700/60 bg-amber-900/30 px-3 py-1.5 text-xs text-amber-300">
                no models configured — ask an admin to add a route
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
              {loadingChat && <Spinner />}
              {blocks.map((b, i) =>
                b.kind === "user" ? (
                  <div
                    key={i}
                    className="ml-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-sm"
                  >
                    {b.text}
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
                  </div>
                ),
              )}
              {busy && <Spinner />}
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
              placeholder={model ? "Message Guild…" : "No model available"}
              disabled={busy || !model}
              className="max-h-40 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2 px-1 pt-1">
              {models.length > 0 ? (
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
              ) : (
                <span className="text-xs text-muted-foreground">no models</span>
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} email={email} />
    </div>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-left">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Appearance</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(["dark", "light", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`rounded-md px-2 py-1.5 text-xs capitalize transition-colors ${
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
        </div>
      </DialogContent>
    </Dialog>
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
}: {
  chats: ChatSummary[];
  chatId: string | null;
  email: string;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
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
      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="space-y-0.5 pb-2">
          {chats.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenChat(c.id)}
              className={`w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                c.id === chatId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
              title={c.title}
            >
              {c.title || "Untitled"}
            </button>
          ))}
          {chats.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet.</p>
          )}
        </div>
      </ScrollArea>
      <Separator />
      <div className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
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
