//! Assistant section of the settings window: the org's admin-configured
//! assistant system prompt. The admin's text replaces the persona sentence
//! ("You are a helpful assistant.") that starts every chat's system prompt;
//! the server always appends its own operational instructions (client-tool
//! behavior, web-search guidance, workspace directory), so a whimsical
//! persona cannot break tool binding. Per-org, admin-only (migration 0028).

import { useEffect, useState } from "react";
import { Button } from "@guild/ui/components/button";
import { Textarea } from "@guild/ui/components/textarea";
import { getAssistantPrompt, setAssistantPrompt } from "../../../transport";

const DEFAULT_PROMPT =
  "You are a helpful assistant. Answer concisely and help with the user's tasks, including software work when asked.";

export function AssistantSection() {
  const [prompt, setPrompt] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setError(null);
    setSaved(false);
    setLoading(true);
    getAssistantPrompt()
      .then((p) => {
        setPrompt(p ?? "");
        setIsCustom(p != null);
      })
      .catch(() => setError("failed to load the current prompt"))
      .finally(() => setLoading(false));
  }, []);

  const save = async (value: string) => {
    if (saving) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await setAssistantPrompt(value);
      setPrompt(value);
      setIsCustom(value.trim().length > 0);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-muted-foreground">
        The system prompt every chat in this organization starts with. This text sets the
        assistant's persona — the server always adds its own tool and workspace instructions
        after it, so those cannot be removed here. Leave empty to use the default.
      </p>
      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          System prompt {isCustom ? "(custom)" : "(default)"}
        </label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          disabled={loading || saving}
          placeholder={DEFAULT_PROMPT}
          className="font-mono text-xs"
        />
        {!isCustom && (
          <p className="text-xs text-muted-foreground">Currently using the default prompt.</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save(prompt)} disabled={saving || loading}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => save("")}
          disabled={saving || loading || (!isCustom && prompt.length === 0)}
        >
          Reset to default
        </Button>
        {saved && <span className="text-xs text-muted-foreground">saved</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}
