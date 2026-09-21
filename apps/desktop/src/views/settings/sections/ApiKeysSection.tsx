//! ApiKeysSection — user-level settings: mint and revoke the `gk_…` API
//! keys that authenticate external clients against the org's LLM gateway
//! (OpenAI-compatible `/openai/v1`, Anthropic-compatible `/anthropic`).
//! Plaintext keys are shown exactly once, at creation.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Plus } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import { serverBase } from "../../../transport";
import {
  createMyApiKey,
  listMyApiKeys,
  revokeMyApiKey,
  type ApiKeyInfo,
} from "../../../transport";
import { relativeTime } from "../../../lib/relative-time";
import { PageHeader } from "../components/page-header";

let lastKeys: ApiKeyInfo[] | null = null;

/** Drops the cached key list; sign-out must call this so one user's key
 * inventory does not leak into the next session. */
export function clearApiKeysCache(): void {
  lastKeys = null;
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(lastKeys);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null);

  useEffect(() => {
    void listMyApiKeys().then((k) => {
      if (k === null) {
        toast.error("Could not load API keys");
        return;
      }
      lastKeys = k;
      setKeys(k);
    });
  }, []);

  const origin = serverBase();

  async function create() {
    const res = await createMyApiKey(name.trim() || "api key");
    if (res === null) {
      toast.error("Could not create API key");
      return;
    }
    lastKeys = [...(lastKeys ?? []), res.key];
    setKeys(lastKeys);
    setIssued(res.plaintext);
    setCreating(false);
    setName("");
    toast.success("API key created");
  }

  async function revoke() {
    if (!revokeTarget) return;
    const ok = await revokeMyApiKey(revokeTarget.id);
    if (!ok) {
      toast.error("Could not revoke API key");
      return;
    }
    lastKeys = (lastKeys ?? []).map((k) =>
      k.id === revokeTarget.id ? { ...k, revoked_at: new Date().toISOString() } : k,
    );
    setKeys(lastKeys);
    setRevokeTarget(null);
    toast.success("API key revoked");
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Keys"
        description="Keys for calling the Guild LLM gateway from outside the app (scripts, agents, SDKs)."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New API key
          </Button>
        }
      />

      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <p className="mb-2 font-medium">Gateway endpoints</p>
        <div className="space-y-1 font-mono text-xs">
          <p>
            OpenAI-compatible:{" "}
            <span className="text-muted-foreground">{origin}/openai/v1</span>{" "}
            <span className="font-sans text-muted-foreground">
              (chat completions, models)
            </span>
          </p>
          <p>
            Anthropic-compatible:{" "}
            <span className="text-muted-foreground">{origin}/anthropic</span>{" "}
            <span className="font-sans text-muted-foreground">
              (messages)
            </span>
          </p>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Auth: <code>Authorization: Bearer gk_…</code> or{" "}
          <code>x-api-key: gk_…</code>. Models resolve against this org's
          routed models, the same ones chats use.
        </p>
      </div>

      {keys === null ? (
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      ) : keys.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          No API keys yet. Create one to give an external client gateway
          access under your account.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-base"
            >
              <div className="flex min-w-0 items-center gap-2">
                <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate">{k.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>{k.prefix}…</code> · created {relativeTime(k.created_at)}
                    {k.revoked_at && ` · revoked ${relativeTime(k.revoked_at)}`}
                  </p>
                </div>
              </div>
              {k.revoked_at ? (
                <span className="shrink-0 pl-3 text-xs text-muted-foreground">revoked</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-destructive"
                  onClick={() => setRevokeTarget(k)}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              Give the key a name you will recognize later (e.g. what uses
              it).
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="my scripts"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={issued !== null} onOpenChange={() => setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time the full key is shown — store it now.
            </DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-lg border border-border bg-muted p-3 text-sm select-all">
            {issued}
          </code>
          <DialogFooter>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(issued ?? "");
                toast.success("Copied to clipboard");
              }}
            >
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeTarget !== null} onOpenChange={() => setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revokeTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Clients using this key immediately lose gateway access. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white" onClick={() => void revoke()}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
