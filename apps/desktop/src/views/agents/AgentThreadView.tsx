import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  SquareTerminal,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Textarea } from "@guild/ui/components/textarea";
import { Skeleton } from "@guild/ui/components/skeleton";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents, WRAP_ANYWHERE } from "../markdown";
import { WorkedForBlock, viewEntries } from "../worked-for-block";
import { eventsToBlocks } from "../../lib/thread-reducer";
import { startSocket, type ThreadEventRow } from "../../transport";
import { relativeTime } from "../../lib/relative-time";
import {
  getAgentThread,
  listAgentThreads,
  renameAgentThread,
  sendAgentTurn,
  type Agent,
  type AgentThread,
} from "./agents-api";
import type { AgentsRoute } from "./agents-route";
import { ErrorState, InlineLoading, Mono, ToneBadge } from "./agent-ui";

export function mergeThreadEvents(
  current: ThreadEventRow[],
  incoming: ThreadEventRow[],
): ThreadEventRow[] {
  const seen = new Set(current.map((row) => row.id));
  const next = [...current];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    next.push(row);
  }
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

export function AgentThreadView({
  agent,
  threadId,
  onNavigate,
}: {
  agent: Agent;
  threadId: string;
  onNavigate: (route: AgentsRoute) => void;
}) {
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ThreadEventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  const chatIdRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setThread(null);
    setEvents([]);
    void getAgentThread(agent.id, threadId)
      .catch(async () => {
        const rows = await listAgentThreads(agent.id);
        const found = rows.find((row) => row.id === threadId);
        if (!found) throw new Error("This thread no longer exists.");
        return found;
      })
      .then((row) => {
        if (!live) return;
        setThread(row);
        chatIdRef.current = row.chat_id;
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Could not load this thread.");
      });
    return () => {
      live = false;
      chatIdRef.current = null;
    };
  }, [agent.id, threadId]);

  useEffect(() => {
    if (thread === null) return;
    const chatId = thread.chat_id;
    const connection = startSocket({
      getOpenChatId: () => chatId,
      onThreadList: () => {},
      onChatStatus: (frame) => {
        if (frame.chat_id === chatId) setBusy(frame.generating);
      },
      onThreadState: (state) => {
        if (state.chat_id !== chatId) return;
        setEvents(state.events);
        setBusy(state.generating);
      },
      onThreadEvents: (cid, _seq, rows) => {
        if (cid !== chatId) return;
        setEvents((current) => mergeThreadEvents(current, rows));
      },
      onFrame: () => {},
      onSync: () => {},
      onError: (message) => {
        if (message === "no such chat") setError("This thread no longer exists.");
      },
    });
    return () => connection.stop();
  }, [thread]);

  const blocks = useMemo(() => eventsToBlocks(events), [events]);
  const entries = useMemo(() => viewEntries(blocks, "casual"), [blocks]);

  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (title === "" || titleSaving) return;
    setTitleSaving(true);
    try {
      const next = await renameAgentThread(agent.id, threadId, title);
      setThread(next);
      setRenaming(false);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "The thread was not renamed.");
    } finally {
      setTitleSaving(false);
    }
  };

  const send = async () => {
    const text = prompt.trim();
    if (text === "" || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendAgentTurn(agent.id, { thread_id: threadId, message: text });
      setPrompt("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "The message did not send.");
    } finally {
      setSending(false);
    }
  };

  if (error !== null) {
    return (
      <div className="space-y-4">
        <BackToThreads agentId={agent.id} onNavigate={onNavigate} />
        <ErrorState message={error} />
      </div>
    );
  }
  if (thread === null) return <InlineLoading label="Loading thread" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <BackToThreads agentId={agent.id} onNavigate={onNavigate} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1">
              <Input
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="h-7 max-w-[28rem] text-sm"
                aria-label="Thread title"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                disabled={titleSaving || titleDraft.trim() === ""}
                onClick={() => void saveTitle()}
                title="Save title"
              >
                {titleSaving ? <Loader2 className="animate-spin" /> : <Check />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setRenaming(false)}
                title="Cancel rename"
              >
                <X />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <p className="truncate text-sm font-medium">
                {thread.title || "Untitled thread"}
              </p>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Rename thread"
                onClick={() => {
                  setTitleDraft(thread.title);
                  setRenaming(true);
                }}
              >
                <Pencil className="size-3" />
              </button>
            </div>
          )}
          <p className="truncate text-2xs text-muted-foreground">
            {agent.name} · {thread.kind === "default" ? "Default thread" : "Thread"} · last activity{" "}
            {relativeTime(thread.last_activity_at)}
          </p>
        </div>
        {busy && (
          <ToneBadge tone="info">
            <Loader2 className="mr-1 size-3 animate-spin" />
            Working
          </ToneBadge>
        )}
        {thread.unread && !busy && <ToneBadge tone="warning">Unread</ToneBadge>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
          {entries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <MessageSquare className="mb-2 size-6" />
              <p className="text-sm">No messages in this thread yet.</p>
              <p className="mt-1 text-xs">Send the first message below.</p>
            </div>
          )}
          {entries.map((entry) =>
            entry.kind === "work" ? (
              <WorkedForBlock
                key={`work-${entry.run[0]!.key}`}
                run={entry.run}
                active={busy}
                stopping={false}
                turnStart={entry.turnStart}
              />
            ) : entry.b.kind === "user" ? (
              <div key={entry.b.key} className="ml-auto w-fit max-w-[85%]">
                <div className={`rounded-2xl bg-secondary px-4 py-2.5 leading-[1.75] ${WRAP_ANYWHERE}`}>
                  <div className="whitespace-pre-wrap">{entry.b.text}</div>
                </div>
              </div>
            ) : entry.b.kind === "text" ? (
              <div
                key={entry.b.key}
                className={`max-w-none space-y-3 leading-[1.75] ${MD_CLASS} ${MD_TABLE_CLASS}`}
              >
                <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {entry.b.text}
                </Markdown>
                {entry.b.interrupted && !busy && (
                  <div className="text-xs text-muted-foreground">stopped</div>
                )}
              </div>
            ) : entry.b.kind === "error" ? (
              <div
                key={entry.b.key}
                className="w-fit rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
              >
                {entry.b.text}
              </div>
            ) : entry.b.kind === "tool" && entry.b.tool ? (
              <div
                key={entry.b.key}
                className="rounded-lg border border-border bg-card px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  <SquareTerminal className="size-3.5 text-muted-foreground" />
                  <span className="font-mono">{entry.b.tool.name}</span>
                  <span className="text-muted-foreground">{entry.b.tool.status}</span>
                </div>
                {entry.b.tool.content && (
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">
                    {entry.b.tool.content}
                  </pre>
                )}
              </div>
            ) : null,
          )}
          {sending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Sending
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border px-3 py-2.5">
        {sendError !== null && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {sendError}
          </p>
        )}
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea
            value={prompt}
            rows={1}
            aria-label="Message this agent"
            placeholder={`Message ${agent.name}`}
            className="max-h-40 min-h-9 resize-none py-2"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            size="icon"
            aria-label="Send message"
            disabled={prompt.trim() === "" || sending}
            onClick={() => void send()}
          >
            {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
        <p className="mx-auto mt-1 w-full max-w-3xl text-2xs text-muted-foreground">
          Runs in the agent workspace. Enter sends, Shift+Enter adds a line.
        </p>
      </div>
    </div>
  );
}

function BackToThreads({
  agentId,
  onNavigate,
}: {
  agentId: string;
  onNavigate: (route: AgentsRoute) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onNavigate({ view: "agent", agentId, tab: "threads" })}
    >
      <ArrowLeft />
      Threads
    </Button>
  );
}

/** Thread list: default thread pinned first, then most recent activity. */
export function sortAgentThreads(threads: AgentThread[]): AgentThread[] {
  const rank = (t: AgentThread) => (t.kind === "default" ? 0 : 1);
  return [...threads].sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    return Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at);
  });
}

export function ThreadList({
  agent,
  onNavigate,
  onNewThread,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
  onNewThread: () => Promise<AgentThread | null>;
}) {
  const [threads, setThreads] = useState<AgentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void listAgentThreads(agent.id)
      .then((rows) => {
        if (live) setThreads(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setThreads(null);
        setError(err instanceof Error ? err.message : "Could not load threads.");
      });
    return () => {
      live = false;
    };
  }, [agent.id, tick]);

  const create = async () => {
    setCreating(true);
    const row = await onNewThread();
    setCreating(false);
    if (row) onNavigate({ view: "agent", agentId: agent.id, tab: "threads", threadId: row.id });
    else setTick((t) => t + 1);
  };

  const sorted = threads === null ? null : sortAgentThreads(threads);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Threads are independent conversations over one shared workspace.
        </p>
        <div className="flex-1" />
        <Button size="sm" onClick={() => void create()} disabled={creating}>
          {creating ? <Loader2 className="animate-spin" /> : <MessageSquare />}
          New thread
        </Button>
      </div>
      {error !== null && <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />}
      {error === null && sorted === null && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}
      {error === null && sorted !== null && sorted.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium">No threads yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The default thread appears after the first message.
          </p>
        </div>
      )}
      {error === null && sorted !== null && sorted.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {sorted.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() =>
                onNavigate({
                  view: "agent",
                  agentId: agent.id,
                  tab: "threads",
                  threadId: thread.id,
                })
              }
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50"
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{thread.title}</span>
                  {thread.kind === "default" && <ToneBadge tone="info">Default</ToneBadge>}
                  {thread.kind === "routine_run" && <ToneBadge tone="neutral">Routine</ToneBadge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Last activity {relativeTime(thread.last_activity_at)}
                </span>
              </span>
              {thread.unread && (
                <span
                  className="size-2 shrink-0 rounded-full bg-amber-400"
                  title="Unread"
                  aria-label="Unread"
                />
              )}
              <Mono>{thread.chat_id.slice(0, 8)}</Mono>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
