import { useState } from "react";
import type { Agent, CoordinationOutcome } from "@guild/wire/rest";
import { pauseCoordination, reevaluateCoordination, retryCoordination } from "../../../desktop/src/views/agents/agents-api";
import { useAgentCoordination } from "../../../desktop/src/views/agents/agents-store";

function outcomeStatus(input: CoordinationOutcome): string {
  if (input.reply_failed_at) return "Reply failed";
  if (input.reply_missing) return "No direct reply";
  if (input.launch_error) return "Launch failed";
  if (input.work_report_state) return input.work_report_state;
  if (input.run_status) return input.run_status;
  if (input.accepted_scope) return "Accepted";
  if (input.decision === "would_accept") return "Would accept";
  if (input.decision) return input.decision;
  if (input.reply_delivered_at) return "Replied";
  if (input.reply_queued) return "Reply queued";
  return input.kind === "candidate" ? "Awaiting evaluation" : "Awaiting reply";
}

type Props = { agent: Agent; onOpenChat?: (chatId: string) => void; onResync?: () => void };

export function CoordinationActivity({ agent, onOpenChat, onResync }: Props) {
  const resources = agent.resources;
  const assistant = resources && typeof resources === "object" && !Array.isArray(resources) ? (resources as Record<string, unknown>).assistant : null;
  const enabled = assistant && typeof assistant === "object" && !Array.isArray(assistant) ? (assistant as Record<string, unknown>).enabled : null;
  if (!(typeof enabled === "boolean" ? enabled : agent.is_personal)) return null;
  return <CoordinationPanel key={agent.id} agent={agent} onOpenChat={onOpenChat} onResync={onResync} />;
}

function CoordinationPanel({ agent, onOpenChat, onResync }: Props) {
  const snapshot = useAgentCoordination(agent.id);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (snapshot?.unavailable) return (
    <section aria-label="Coordination" className="mb-5 space-y-2">
      <h2 className="font-medium">Coordination</h2>
      <p role="alert">Could not load coordination.</p>
      {onResync && <button type="button" className="underline" onClick={onResync}>Retry</button>}
    </section>
  );

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Coordination" className="mb-5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">Coordination{snapshot?.paused ? " · Paused" : ""}</h2>
        {snapshot && agent.can_manage && (
          <button type="button" className="underline" disabled={busy}
            onClick={() => void act(() => pauseCoordination(agent.id, !snapshot.paused))}>
            {snapshot.paused ? "Resume" : "Pause"}
          </button>
        )}
      </div>
      {actionError && <p role="alert">{actionError}</p>}
      {!snapshot && <p role="status">Loading coordination…</p>}
      {snapshot?.outcomes.length === 0 && <p className="text-sm">No coordination activity yet.</p>}
      <ul className="max-h-80 divide-y overflow-y-auto text-sm">
        {snapshot?.outcomes.map((input) => (
          <li key={input.id} className="space-y-1 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium capitalize">{outcomeStatus(input)}</span>
              {input.source_name && <span>{input.source_name} · {input.source_key}</span>}
              <time dateTime={input.created_at}>{new Date(input.created_at).toLocaleString()}</time>
              {input.retryable && <button type="button" className="underline" disabled={busy}
                onClick={() => void act(() => retryCoordination(agent.id, input.id))}>Retry work</button>}
              {agent.can_manage && input.owned && input.kind === "candidate" &&
                ["ignored", "would_accept", "unavailable"].includes(input.decision ?? "") && (
                <button type="button" className="underline" disabled={busy}
                  onClick={() => void act(() => reevaluateCoordination(agent.id, input.id))}>Re-evaluate</button>
              )}
              {onOpenChat && input.worker_chat_id && <button type="button" className="underline"
                onClick={() => onOpenChat(input.worker_chat_id!)}>Open worker chat</button>}
              {onOpenChat && input.source_chat_id && <button type="button" className="underline"
                onClick={() => onOpenChat(input.source_chat_id!)}>Open source chat</button>}
            </div>
            {input.decision_reason && <p className="break-words">{input.decision_reason}</p>}
            {input.accepted_scope && <p className="break-words">{input.accepted_scope}</p>}
            {input.work_report_summary && <p className="break-words">{input.work_report_summary}</p>}
            {input.work_report_question && <p className="break-words">{input.work_report_question}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
