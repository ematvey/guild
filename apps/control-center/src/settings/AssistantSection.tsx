//! Assistant section of the settings window: the org's admin-configured
//! assistant system prompt and the "Approve for me" auto-approval policy
//! prompt. The admin's system-prompt text replaces the persona sentence that
//! starts every chat's system prompt; the server always appends its own
//! operational instructions (client-tool behavior, web-search guidance,
//! workspace directory), so a whimsical persona cannot break tool binding.
//! The approval-policy prompt is the instruction the safety judge runs under
//! when a chat's approval mode is "Approve for me". Both fields always show
//! the current effective text filled in (the default as the value, not a
//! placeholder); saving writes the box, resetting clears the override and
//! restores the default text. Per-org, admin-only (migration 0028 / org KV).

import { useEffect, useRef, useState } from "react";
import { SkeletonText } from "@guild/ui/components/skeleton";
import { Button } from "@guild/ui/components/button";
import { Textarea } from "@guild/ui/components/textarea";
import { toast } from "sonner";
import {
  getApprovalPolicyPrompt,
  getAssistantPrompt,
  setApprovalPolicyPrompt,
  setAssistantPrompt,
} from "../../../desktop/src/lib/api/approvals";
import { PageHeader } from "../../../desktop/src/components/page-header";
import { Field } from "../../../desktop/src/views/settings/components/field";
import { useTransientFlag } from "../../../desktop/src/lib/use-transient";

type Loaded = { custom: string | null; fallback: string };

export function AssistantSection() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Assistant"
        description={`Prompts every chat in this organization runs with. The server always adds its own tool and workspace instructions after the system prompt; the approval policy is the judge instruction behind the chat picker's "Approve for me" mode. Fields show the current effective text; edit and save to override, reset to restore the default.`}
      />
      <PromptField
        label="System prompt"
        load={async () => {
          const v = await getAssistantPrompt();
          return { custom: v?.prompt ?? null, fallback: v?.default ?? "" };
        }}
        save={setAssistantPrompt}
        fallbackNote="Currently using the default prompt."
        rows={8}
      />
      <PromptField
        label={'Approval policy prompt ("Approve for me" mode)'}
        load={async () => {
          const v = await getApprovalPolicyPrompt();
          return { custom: v.prompt, fallback: v.default };
        }}
        save={setApprovalPolicyPrompt}
        fallbackNote="Currently using the default approval policy."
        rows={10}
      />
    </div>
  );
}

function PromptField({
  label,
  load,
  save,
  fallbackNote,
  rows,
}: {
  label: string;
  load: () => Promise<Loaded>;
  save: (value: string) => Promise<void>;
  fallbackNote: string;
  rows: number;
}) {
  const [prompt, setPrompt] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved, clearSaved] = useTransientFlag(1500);

  // The first read: the field loads its prompt once, through the load
  // function it mounted with.
  const loadRef = useRef(load);
  useEffect(() => {
    setError(null);
    clearSaved();
    setLoading(true);
    loadRef
      .current()
      .then((r) => {
        setLoaded(true);
        // The field renders the CURRENT effective text filled in: the
        // server's default fills the box when no custom value is stored.
        setFallbackText(r.fallback);
        setPrompt(r.custom ?? r.fallback);
        setIsCustom(r.custom != null);
      })
      .catch(() => setError("failed to load the current prompt"))
      .finally(() => setLoading(false));
  }, [clearSaved]);

  const persist = async (value: string, markCustom: boolean) => {
    if (saving) return;
    setError(null);
    clearSaved();
    setSaving(true);
    try {
      await save(value);
      setPrompt(value);
      setIsCustom(markCustom);
      flashSaved();
      toast.success(`${label} saved`);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setSaving(false);
    }
  };

  // Reset clears the stored override and shows the default text again — the
  // box keeps displaying the effective prompt as filled text.
  const reset = async () => {
    if (saving) return;
    setError(null);
    clearSaved();
    setSaving(true);
    try {
      await save("");
      setPrompt(fallbackText);
      setIsCustom(false);
      flashSaved();
      toast.success(`${label} reset`);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast.error("Reset failed", { description: msg });
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <Field label={label}>
        <div className="rounded-md border border-border p-3" style={{ minHeight: `${rows + 1}rem` }}>
          <SkeletonText lines={Math.min(rows, 5)} />
        </div>
      </Field>
    );
  if (!loaded)
    return (
      <Field label={label}>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </Field>
    );

  return (
    <Field label={`${label} ${isCustom ? "(custom)" : "(default)"}`}>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={rows}
        disabled={loading || saving}
        className="font-mono text-xs"
      />
      {!isCustom && <p className="mt-1.5 text-xs text-muted-foreground">{fallbackNote}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => persist(prompt.trim().length > 0 ? prompt : "", true)}
          disabled={saving || loading || prompt.trim().length === 0}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={reset} disabled={saving || loading || !isCustom}>
          Reset to default
        </Button>
        {saved && <span className="text-xs text-muted-foreground">saved</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Field>
  );
}
