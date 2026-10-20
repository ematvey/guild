import { useEffect, useMemo, useState } from "react";
import { Check, Inbox, MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { relativeTime } from "../../lib/relative-time";
import { INBOX_KIND_LABEL, type AgentsRoute, type InboxKind } from "./agents-route";
import { listInbox, markInboxRead, type AgentNotice } from "./agents-api";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
  PageBody,
  PageHeader,
  TabBar,
  ToneBadge,
} from "./agent-ui";

/** The human line an inbox item carries, from the notice payload. Unknown
 *  payload shapes fall back to the kind label rather than blank text. */
export function noticeText(notice: AgentNotice): string {
  const payload = notice.payload ?? {};
  for (const key of ["message", "question", "summary", "text", "title", "prompt"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return INBOX_KIND_LABEL[notice.kind];
}

export function inboxTone(kind: InboxKind): "danger" | "warning" | "info" | "neutral" {
  switch (kind) {
    case "approval":
      return "warning";
    case "routine_failed":
      return "danger";
    case "question":
      return "info";
    case "routine_message":
      return "neutral";
  }
}

export function InboxPage({
  onNavigate,
  onOpenChat,
  onChanged,
}: {
  onNavigate: (route: AgentsRoute) => void;
  onOpenChat?: (chatId: string) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<AgentNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void listInbox()
      .then((rows) => {
        if (live) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setItems(null);
        setError(err instanceof Error ? err.message : "The inbox API did not answer.");
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const visible = useMemo(() => {
    const rows = items ?? [];
    const filtered = tab === "unread" ? rows.filter((n) => !n.read_at) : rows;
    return [...filtered].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    );
  }, [items, tab]);
  const unread = (items ?? []).filter((n) => !n.read_at).length;

  const markRead = async (notice: AgentNotice, read = true) => {
    setItems((current) =>
      current?.map((n) =>
        n.id === notice.id ? { ...n, read_at: read ? new Date().toISOString() : null } : n,
      ) ?? current,
    );
    try {
      await markInboxRead(notice.id, read);
      onChanged?.();
    } catch {
      setTick((t) => t + 1);
    }
  };

  const open = (notice: AgentNotice) => {
    if (!notice.read_at) void markRead(notice, true);
    const runId =
      notice.run_id ?? (typeof notice.payload.run_id === "string" ? notice.payload.run_id : null);
    const threadId =
      notice.thread_id ??
      (typeof notice.payload.thread_id === "string" ? notice.payload.thread_id : null);
    if (runId) {
      onNavigate({ view: "run", runId });
      return;
    }
    if (notice.agent_id && threadId) {
      onNavigate({
        view: "agent",
        agentId: notice.agent_id,
        tab: "threads",
        threadId,
      });
      return;
    }
    if (notice.agent_id) {
      onNavigate({ view: "agent", agentId: notice.agent_id, tab: "overview" });
      return;
    }
    if (onOpenChat && typeof notice.payload?.chat_id === "string") {
      onOpenChat(notice.payload.chat_id);
    }
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PageHeader
        title="Inbox"
        description={
          unread > 0
            ? `${unread} item${unread === 1 ? "" : "s"} need attention.`
            : "Nothing needs attention."
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => setTick((t) => t + 1)}>
            <RefreshCw />
            Refresh
          </Button>
        }
        tabs={
          <TabBar
            label="Inbox filter"
            tabs={[
              ["unread", unread > 0 ? `Unread (${unread})` : "Unread"],
              ["all", "All"],
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      <PageBody>
        {error !== null && (
          <ErrorState
            title="Could not load the inbox"
            message={error}
            onRetry={() => setTick((t) => t + 1)}
          />
        )}
        {error === null && items === null && <LoadingRows rows={4} />}
        {error === null && items !== null && visible.length === 0 && (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title={tab === "unread" ? "Inbox is clear" : "No attention items"}
            body="Questions, approvals, failed routines and routine messages appear here."
          />
        )}
        {error === null && visible.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {visible.map((notice) => (
              <div
                key={notice.id}
                className={`flex items-start gap-3 border-b border-border px-3 py-3 last:border-b-0 ${
                  notice.read_at ? "opacity-70" : ""
                }`}
              >
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    notice.read_at ? "bg-transparent" : "bg-amber-400"
                  }`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left outline-none"
                  onClick={() => open(notice)}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ToneBadge tone={inboxTone(notice.kind)}>
                      {INBOX_KIND_LABEL[notice.kind]}
                    </ToneBadge>
                    {notice.agent_name && (
                      <span className="text-[12px] text-muted-foreground">
                        {notice.agent_name}
                      </span>
                    )}
                    <span className="text-[12px] text-muted-foreground">
                      · {relativeTime(notice.created_at)}
                    </span>
                  </span>
                  <span className="mt-1 block whitespace-pre-wrap text-[13.5px]">
                    {noticeText(notice)}
                  </span>
                  {notice.thread_id && (
                    <span className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
                      <MessageSquare className="size-3" />
                      Open thread
                    </span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={notice.read_at ? "Mark unread" : "Mark read"}
                  onClick={() => void markRead(notice, !notice.read_at)}
                >
                  <Check />
                  {notice.read_at ? "Unread" : "Read"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </PageBody>
    </div>
  );
}
