// Thread list for an agent: most
// recent activity. A thread opens at its canonical chat address. The list is
// live: the member socket pushes it whenever one of the threads changes.

import { useState } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { relativeTime } from "../../../desktop/src/lib/relative-time";
import type { Agent, AgentThread } from "../../../desktop/src/views/agents/agents-api";
import type { AgentsRoute } from "../../../desktop/src/views/agents/agents-route";
import { ErrorState, Mono, ToneBadge } from "../../../desktop/src/views/agents/agent-ui";
import { useAgentThreads } from "../../../desktop/src/views/agents/agents-store";

/** Thread list: most recent activity first. */
export function sortAgentThreads(threads: AgentThread[]): AgentThread[] {
  return [...threads].sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at));
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
  const { rows: threads, error: loadError, retry } = useAgentThreads(agent.id);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    const row = await onNewThread();
    setCreating(false);
    if (row) {
      if (onOpenChat) onOpenChat(row.chat_id);
      else onNavigate({ view: "agent", agentId: agent.id, tab: "threads" });
    }
  };

  const sorted = threads === null ? null : sortAgentThreads(threads);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Threads are independent conversations over one shared workspace.
        </p>
        <div className="flex-1" />
        <Button size="sm" onClick={() => void create()} disabled={creating || agent.status === "deleting"}>
          {creating ? <Loader2 className="animate-spin" /> : <MessageSquare />}
          New thread
        </Button>
      </div>
      {loadError !== null && <ErrorState title="Could not load threads" message={loadError} onRetry={retry} />}
      {sorted === null && loadError === null && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}
      {sorted !== null && sorted.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium">No threads yet</p>
          <p className="mt-1 text-sm text-muted-foreground">A thread appears after its first message.</p>
        </div>
      )}
      {sorted !== null && sorted.length > 0 && (
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
                  {thread.type === "routine" && <ToneBadge tone="neutral">Routine</ToneBadge>}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Last activity {relativeTime(thread.last_activity_at)}
                </span>
              </span>
              <Mono>{thread.chat_id.slice(0, 8)}</Mono>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
