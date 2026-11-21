import { Button } from "@guild/ui/components/button";
import { relativeTime } from "../../lib/relative-time";
import { useAgentThreads } from "./agents-store";

/** Member-visible work, updated by the Agent thread socket feed. */
export function AssistantActivity({
  agentId,
  onOpenChat,
  onBack,
}: {
  agentId: string;
  onOpenChat: (chatId: string) => void;
  onBack: () => void;
}) {
  const { rows, error, retry } = useAgentThreads(agentId);
  const tasks = rows?.filter((thread) => thread.type !== "user");
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Assistant activity</h1>
        <Button variant="outline" onClick={onBack}>
          Back to assistant
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Open a task to follow its work or continue the conversation.</p>
      {error && (
        <div role="alert" className="text-sm">
          {error}
          <Button variant="ghost" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {rows === null && !error && <p className="text-sm text-muted-foreground">Loading activity…</p>}
      {tasks?.length === 0 && <p className="text-sm text-muted-foreground">No background tasks yet.</p>}
      <div className="divide-y rounded-lg border">
        {tasks?.map((thread) => (
          <button
            key={thread.id}
            type="button"
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-accent"
            onClick={() => onOpenChat(thread.chat_id)}
          >
            <span className="text-sm font-medium">{thread.title}</span>
            <span className="text-xs text-muted-foreground">{relativeTime(thread.last_activity_at)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
