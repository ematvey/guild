// The approval card: a tool call waiting for the user's decision. Pending
// cards offer Approve/Deny wired to the approvals endpoint.
import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Frame } from "../frame";
import { postApproval } from "../../lib/api/approvals";
import { useTransient } from "../../lib/use-transient";
import type { ApprovalBlock } from "../../lib/thread-reducer";
import { toolDisplayName } from "./tool-text";

/// Status pill on approval cards (mirrors the tool-frame pill palette).
function ApprovalPill({ status }: { status: "pending" | "approved" | "denied" | "expired" }) {
  const cls = {
    pending: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    denied: "border-destructive/40 bg-destructive/10 text-destructive",
    expired: "border-border bg-muted text-muted-foreground",
  }[status];
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-px text-xs uppercase tracking-wide ${cls}`}>{status}</span>
  );
}

/// Collapsible approval card (design spec section F), styled like the tool
/// frames. Pending cards offer Approve/Deny wired to the approvals endpoint;
/// the buttons optimistically disable on click and the card flips to the
/// resolved pill when the approval_resolved frame (or a thread reload)
/// confirms the decision. A settled response (recorded decision echoed, or
/// the call journaled expired) settles the card directly from the POST —
/// no frame is coming for those paths. A click whose POST hangs or lands
/// during the gate's own settle re-enables after 15 s so it can be retried;
/// retries are idempotent (the endpoint echoes the recorded decision).
export function ApprovalCard({ a, chatId }: { a: ApprovalBlock; chatId: string | null }) {
  // The optimistic click: it re-enables after 15 s if no answer settles it.
  const {
    value: acted,
    show: showActed,
    hold: holdActed,
    clear: clearActed,
  } = useTransient<null | "approved" | "denied">(null, 15_000);
  const [remote, setRemote] = useState<null | { status: "approved" | "denied" | "expired"; reason?: string }>(null);
  const status = remote?.status ?? a.status;
  const settled = status !== "pending";
  const busy = !settled && acted !== null;
  const act = (approved: boolean) => {
    if (acted || settled || !chatId) return;
    showActed(approved ? "approved" : "denied");
    void postApproval(chatId, a.callId, approved, approved ? undefined : "denied by user")
      .then((r) => {
        holdActed();
        if (r.settled) {
          setRemote({
            status: r.expired ? "expired" : r.approved ? "approved" : "denied",
            reason: r.reason ?? undefined,
          });
          clearActed();
        }
        // settled=false: the gate took the decision and is journaling it —
        // the resolved frame (or a reload) lands the pill; keep the
        // optimistic state until then.
      })
      .catch(() => clearActed());
  };
  let prettyArgs = a.args;
  try {
    prettyArgs = JSON.stringify(JSON.parse(a.args), null, 2);
  } catch {
    /* keep the raw arguments string */
  }
  // Shell-like tools get a terminal-style command line instead of the raw
  // JSON argument dump.
  let commandLine: string | null = null;
  if (a.name === "execute" || a.name === "bash" || a.name === "shell") {
    try {
      const parsed = JSON.parse(a.args);
      const cmd = parsed?.command ?? parsed?.cmd ?? parsed?.script;
      if (typeof cmd === "string" && cmd) commandLine = cmd;
    } catch {
      /* fall through to the JSON block */
    }
  }
  return (
    <Frame
      icon={
        settled && status !== "approved" ? (
          <ShieldAlert className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ShieldCheck className="size-3 shrink-0 text-muted-foreground" />
        )
      }
      title={
        <>
          <span className="font-medium text-foreground/80">{toolDisplayName(a.name)}</span>
          <span className="text-muted-foreground"> — approval</span>
        </>
      }
      badge={
        <>
          {a.reason && settled && status !== "expired" && (
            <span className="hidden max-w-40 truncate text-muted-foreground sm:inline">{a.reason}</span>
          )}
          <ApprovalPill
            status={
              settled
                ? (status as "approved" | "denied" | "expired")
                : busy
                  ? (acted as "approved" | "denied")
                  : "pending"
            }
          />
        </>
      }
      defaultOpen={status === "pending"}
    >
      <div className="space-y-2">
        {commandLine !== null ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 text-sm leading-relaxed">
            <span className="select-none text-muted-foreground/60">$ </span>
            {commandLine}
          </pre>
        ) : (
          prettyArgs && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
              {prettyArgs}
            </pre>
          )
        )}
        {a.judge?.reason && (
          <p className="rounded-md border border-border bg-muted/60 px-2.5 py-2 text-muted-foreground">
            <span className="font-medium text-foreground/70">Approval judge:</span> {a.judge.reason}
          </p>
        )}
        {settled ? (
          status === "expired" ? (
            <p className="text-muted-foreground">expired — the turn was no longer waiting for this approval</p>
          ) : status === "denied" && (remote?.reason ?? a.reason) ? (
            <p className="text-muted-foreground">denied: {remote?.reason ?? a.reason}</p>
          ) : status === "denied" ? (
            <p className="text-muted-foreground">denied by user</p>
          ) : (
            <p className="text-muted-foreground">approved — the tool was allowed to run</p>
          )
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => act(true)} disabled={busy}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => act(false)} disabled={busy}>
              Deny
            </Button>
            {busy && <span className="text-muted-foreground">sending…</span>}
          </div>
        )}
      </div>
    </Frame>
  );
}
