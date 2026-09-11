//! Approvals section of the settings window: the per-chat approval policy
//! (default mode + optional per-tool overrides). Moved from the old settings
//! dialog; applies to the currently open chat.

import { useEffect, useState } from "react";
import { Button } from "@guild/ui/components/button";
import { Textarea } from "@guild/ui/components/textarea";
import { getApproval, setApproval, type ApprovalPolicy } from "../../../transport";

export function ApprovalsSection({ chatId }: { chatId: string | null }) {
  const [policyDefault, setPolicyDefault] = useState<"server" | "ask" | "allow" | "never">("server");
  const [overridesText, setOverridesText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setError(null);
    setSaved(false);
    if (!chatId) return;
    setLoading(true);
    getApproval(chatId)
      .then((p) => {
        setPolicyDefault(p?.default ?? "server");
        setOverridesText(
          p?.overrides && Object.keys(p.overrides).length > 0
            ? JSON.stringify({ overrides: p.overrides }, null, 2)
            : "",
        );
      })
      .catch(() => setError("failed to load the current policy"))
      .finally(() => setLoading(false));
  }, [chatId]);

  const save = async () => {
    if (!chatId || saving) return;
    setError(null);
    setSaved(false);
    let policy: ApprovalPolicy | null = null;
    if (policyDefault !== "server") {
      policy = { default: policyDefault };
      const txt = overridesText.trim();
      if (txt) {
        try {
          const parsed = JSON.parse(txt) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("must be a JSON object");
          }
          const obj = parsed as { overrides?: unknown };
          if (obj.overrides !== undefined) {
            if (typeof obj.overrides !== "object" || obj.overrides === null || Array.isArray(obj.overrides)) {
              throw new Error('"overrides" must be an object');
            }
            policy.overrides = obj.overrides as ApprovalPolicy["overrides"];
          } else {
            policy.overrides = parsed as ApprovalPolicy["overrides"];
          }
        } catch (e) {
          setError(`invalid overrides JSON: ${(e as Error).message}`);
          return;
        }
      }
    }
    setSaving(true);
    try {
      await setApproval(chatId, policy);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!chatId) {
    return (
      <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        Open a chat to configure its approval policy.
      </p>
    );
  }

  const modes: { id: typeof policyDefault; label: string; hint: string }[] = [
    { id: "server", label: "Server default", hint: "ask, read-only tools allowed" },
    { id: "ask", label: "Ask", hint: "approval card per state-changing tool call" },
    { id: "allow", label: "Allow all", hint: "tools run without approval cards" },
    { id: "never", label: "Deny all", hint: "every tool call is refused" },
  ];

  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-1.5">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => setPolicyDefault(m.id)}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
              policyDefault === m.id
                ? "border-foreground/40 bg-accent"
                : "border-border bg-card hover:bg-accent/50"
            }`}
          >
            <span>
              <span className="font-medium">{m.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">{m.hint}</span>
            </span>
            <span
              className={`size-3.5 rounded-full border-2 ${
                policyDefault === m.id ? "border-foreground bg-foreground" : "border-border"
              }`}
            />
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Per-tool overrides (JSON, optional)
        </label>
        <Textarea
          value={overridesText}
          onChange={(e) => setOverridesText(e.target.value)}
          rows={3}
          placeholder={'{"overrides": {"bash": "allow"}}'}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Keys are tool names, values are ask / allow / never.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || loading}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">saved</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}
