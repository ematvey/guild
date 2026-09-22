//! GatewaySection — user-level settings: the org's LLM gateway. Mint and
//! revoke the `gk_…` API keys that authenticate external clients (OpenAI-
//! compatible `/openai/v1`, Anthropic-compatible `/anthropic`), plus the
//! connection guide — a brief summary on the page, full per-client examples
//! in the details popup. Plaintext keys are shown exactly once, at creation.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BookOpen, Copy, KeyRound, Plus } from "lucide-react";
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
export function clearGatewayCache(): void {
  lastKeys = null;
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3" /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-3 text-xs leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

const SURFACES = ["OpenAI", "Anthropic"] as const;

export function GatewaySection() {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(lastKeys);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null);
  const [details, setDetails] = useState(false);
  const [surface, setSurface] = useState<(typeof SURFACES)[number]>("OpenAI");

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
  const openaiBase = `${origin}/openai/v1`;
  const anthropicBase = `${origin}/anthropic`;

  const exampleKey = "gk_your-key-here";

  const examples: Record<(typeof SURFACES)[number], { label: string; code: string }[]> = {
    OpenAI: [
      {
        label: "curl",
        code: `curl ${openaiBase}/chat/completions \\
  -H "Authorization: Bearer ${exampleKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<routed-model>",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
      {
        label: "Python (openai)",
        code: `from openai import OpenAI

client = OpenAI(base_url="${openaiBase}", api_key="${exampleKey}")
resp = client.chat.completions.create(
    model="<routed-model>",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`,
      },
      {
        label: "TypeScript (openai)",
        code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${openaiBase}",
  apiKey: "${exampleKey}",
});
const resp = await client.chat.completions.create({
  model: "<routed-model>",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(resp.choices[0].message.content);`,
      },
      {
        label: "List available models",
        code: `curl ${openaiBase}/models -H "Authorization: Bearer ${exampleKey}"`,
      },
    ],
    Anthropic: [
      {
        label: "curl",
        code: `curl ${anthropicBase}/v1/messages \\
  -H "x-api-key: ${exampleKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<routed-model>",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      },
      {
        label: "Python (anthropic)",
        code: `from anthropic import Anthropic

client = Anthropic(base_url="${anthropicBase}", api_key="${exampleKey}")
msg = client.messages.create(
    model="<routed-model>",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(msg.content[0].text)`,
      },
      {
        label: "TypeScript (anthropic)",
        code: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${anthropicBase}",
  apiKey: "${exampleKey}",
});
const msg = await client.messages.create({
  model: "<routed-model>",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
console.log(msg.content[0].text);`,
      },
    ],
  };

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
        title="Gateway"
        description="The org's LLM gateway: call the routed models from outside the app — scripts, agents, SDKs."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDetails(true)}>
              <BookOpen className="size-4" /> How to connect
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New API key
            </Button>
          </div>
        }
      />

      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <p className="mb-2 font-medium">Connecting in three steps</p>
        <ol className="list-inside list-decimal space-y-1 text-muted-foreground">
          <li>Create an API key below (it starts with <code>gk_</code>).</li>
          <li>
            Point your client at{" "}
            <code>{openaiBase}</code> (OpenAI-compatible) or{" "}
            <code>{anthropicBase}</code> (Anthropic-compatible).
          </li>
          <li>
            Authenticate with <code>Authorization: Bearer gk_…</code> or{" "}
            <code>x-api-key: gk_…</code> — any routed model works, the same
            ones chats use.
          </li>
        </ol>
        <Button variant="link" className="h-auto p-0 text-xs" onClick={() => setDetails(true)}>
          Full examples for curl, Python, and TypeScript →
        </Button>
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

      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connecting to the gateway</DialogTitle>
            <DialogDescription>
              Both surfaces serve the org's routed models with your API key
              (<code>gk_…</code>). OpenAI clients speak{" "}
              <code>/openai/v1</code>; Anthropic clients speak{" "}
              <code>/anthropic</code> (the SDK appends <code>/v1/messages</code>).
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-1">
            {SURFACES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={surface === s ? "default" : "outline"}
                onClick={() => setSurface(s)}
              >
                {s}
              </Button>
            ))}
          </div>
          <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
            {examples[surface].map((ex) => (
              <Snippet key={ex.label} label={ex.label} code={ex.code} />
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetails(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
