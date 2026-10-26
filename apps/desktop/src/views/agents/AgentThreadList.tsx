// Thread list for an agent: the default thread pinned first, then most
// recent activity. A thread opens at its canonical chat address.

import { useEffect, useState } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { relativeTime } from "../../lib/relative-time";
import { listAgentThreads, type Agent, type AgentThread } from "./agents-api";
import type { AgentsRoute } from "./agents-route";
import { ErrorState, Mono, ToneBadge } from "./agent-ui";

/** Thread list: default thread pinned first, then most recent activity. */
export function sortAgentThreads(threads: AgentThread[]): AgentThread[] {
  const rank = (t: AgentThread) => (t.is_default ? 0 : 1);
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
  onOpenChat,
}: {
  agent: Agent;
  onNavigate: (route: AgentsRoute) => void;
  onNewThread: () => Promise<AgentThread | null>;
  /** A thread has one canonical address: its chat. */
  onOpenChat?: (chatId: string) => void;
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
    if (row) {
      if (onOpenChat) onOpenChat(row.chat_id);
      else onNavigate({ view: "agent", agentId: agent.id, tab: "threads" });
    }
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
                onOpenChat
                  ? onOpenChat(thread.chat_id)
                  : onNavigate({ view: "agent", agentId: agent.id, tab: "threads" })
              }
              className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left outline-none transition-colors last:border-b-0 hover:bg-accent/50"
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{thread.title}</span>
                  {thread.is_default && <ToneBadge tone="info">Default</ToneBadge>}
                  {thread.type === "routine" && <ToneBadge tone="neutral">Routine</ToneBadge>}
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
