//! The Models section's provider pages (add, detail) plus the row types and
//! chips the list and route pages share. A detail page shows the saved row
//! as facts; Edit seeds a local draft from it.

import { useMemo, useState } from "react";
import { useCachedGet } from "../use-cached-api";
import { createProvider, deleteProvider, SETTINGS_PATHS, updateProvider } from "../../../lib/api/settings";
import { Blocks, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
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
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { SkeletonForm } from "@guild/ui/components/skeleton";
import { PageHeader } from "../../../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "@guild/ui/components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";

export interface RouteRow {
  model: string;
  /** User-visible display name; empty falls back to the model id. */
  alias: string;
  provider: string;
  enabled: boolean;
  price_per_mtok_in_usd: number;
  price_per_mtok_out_usd: number;
  quota_monthly_usd: number | null;
  reasoning: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
  temperature: number | null;
  modalities: string[];
}

export interface ProviderRow {
  provider: string;
  name: string;
  protocol: string;
  base_url: string;
  key_masked?: string | null;
}

export const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}/Mtok`;

export const MODALITIES = ["image", "audio", "video"] as const;
const PROTOCOLS = ["openai", "anthropic"] as const;

export function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
      title={enabled ? "enabled" : "disabled"}
    />
  );
}

export function Chip({ children }: { children: string }) {
  return (
    <Badge variant="secondary" className="uppercase">
      {children}
    </Badge>
  );
}

function useProviders(): { providers: ProviderRow[] | null; settled: boolean; error: string | null } {
  const res = useCachedGet<{ providers: ProviderRow[] }>(SETTINGS_PATHS.gatewayProviders);
  return { providers: res.data?.providers ?? null, settled: res.settled, error: res.error };
}

/// Shared provider form fields for the add and edit screens.
function ProviderFormFields({
  name,
  protocol,
  baseUrl,
  key,
  keyHint,
  storedKeyMasked,
  onPatch,
}: {
  name: string;
  protocol: string;
  baseUrl: string;
  key: string;
  keyHint: string;
  storedKeyMasked?: string | null;
  onPatch: (p: { name?: string; protocol?: string; baseUrl?: string; key?: string }) => void;
}) {
  return (
    <>
      <Field label="Name" hint="Your label for this endpoint — routes reference it by its slug.">
        <Input
          value={name}
          placeholder="e.g. DeepSeek via OpenRouter"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </Field>
      <Field label="Protocol" hint="The wire shape the endpoint speaks.">
        <Select value={protocol} onValueChange={(v) => onPatch({ protocol: v })}>
          <SelectTrigger className="max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROTOCOLS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Base URL">
        <Input
          value={baseUrl}
          placeholder="https://api.openai.com"
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
        />
      </Field>
      <Field label="API key" hint={keyHint}>
        {/* Stored keys preview as one bullet per stored character — the
            placeholder must read as a masked value, not an empty field. */}
        <Input
          type="password"
          value={key}
          placeholder={storedKeyMasked ?? "sk-…"}
          onChange={(e) => onPatch({ key: e.target.value })}
        />
      </Field>
    </>
  );
}

export function ProviderAdd({ onCreated, onBack }: { onCreated: (slug: string) => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<string>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createProvider<{ provider: string }>({
        name: name.trim(),
        protocol,
        base_url: baseUrl.trim(),
        key,
      });
      toast.success("Provider created", { description: name.trim() });
      onCreated(res.provider);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not create provider", { description: msg });
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Add a provider"
        description="The provider gets a stable slug derived from the name; model routes reference that slug."
        back={{ label: "Models", onClick: onBack }}
      />
      <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
        <ProviderFormFields
          name={name}
          protocol={protocol}
          baseUrl={baseUrl}
          key={key}
          keyHint="Stored server-side; never returned to the UI."
          onPatch={(p) => {
            if (p.name !== undefined) setName(p.name);
            if (p.protocol !== undefined) setProtocol(p.protocol);
            if (p.baseUrl !== undefined) setBaseUrl(p.baseUrl);
            if (p.key !== undefined) setKey(p.key);
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button disabled={!name.trim() || !baseUrl.trim() || !key || busy} onClick={create}>
            {busy ? "Creating…" : "Create provider"}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProviderDetail({
  slug,
  onChanged,
  onBack,
}: {
  slug: string;
  onChanged: () => void;
  onBack: () => void;
}) {
  const { providers, settled, error: loadError } = useProviders();
  const p = useMemo(() => providers?.find((x) => x.provider === slug) ?? null, [providers, slug]);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<{ name: string; protocol: string; baseUrl: string; key: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (settled && providers !== null && p === null) {
    return (
      <div>
        <PageHeader title="Provider not found" back={{ label: "Models", onClick: onBack }} />
        <EmptyState
          icon={Blocks}
          title={`No provider "${slug}"`}
          hint="It may have been deleted. Routes that referenced it stop resolving."
        />
      </div>
    );
  }
  if (p === null) {
    if (loadError)
      return (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      );
    return (
      <div>
        <PageHeader title={slug} back={{ label: "Models", onClick: onBack }} />
        <SkeletonForm />
      </div>
    );
  }

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateProvider(slug, {
        name: draft.name.trim(),
        protocol: draft.protocol,
        base_url: draft.baseUrl.trim(),
        ...(draft.key ? { key: draft.key } : {}),
      });
      toast.success("Provider saved", { description: draft.name.trim() });
      onChanged();
      setDraft(null);
      setMode("view");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteProvider(slug);
      toast.success("Provider deleted", { description: p.name });
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  if (mode === "edit" && draft !== null) {
    return (
      <div>
        <PageHeader title="Edit provider" description={slug} back={{ label: "Models", onClick: onBack }} />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          <ProviderFormFields
            name={draft.name}
            protocol={draft.protocol}
            baseUrl={draft.baseUrl}
            key={draft.key}
            keyHint="Leave blank to keep the stored key."
            storedKeyMasked={p.key_masked}
            onPatch={(patch) => setDraft({ ...draft, ...patch })}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setError(null);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={p.name}
        description={`Speaks the ${p.protocol} protocol.`}
        back={{ label: "Models", onClick: onBack }}
        actions={
          <>
            <Button
              onClick={() => {
                setDraft({ name: p.name, protocol: p.protocol, baseUrl: p.base_url, key: "" });
                setMode("edit");
              }}
            >
              Edit
            </Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />
      <FactGrid>
        <FactCard label="Name">
          <span>{p.name}</span>
        </FactCard>
        <FactCard label="Protocol">
          <Chip>{p.protocol}</Chip>
        </FactCard>
        <FactCard label="Base URL">
          <span className="break-all">{p.base_url}</span>
        </FactCard>
        <FactCard label="API key">
          <span className="font-mono break-all">{p.key_masked ?? "not decryptable"}</span>
        </FactCard>
        <FactCard label="Slug — routes reference this id">
          <span className="font-mono text-sm">{p.provider}</span>
        </FactCard>
      </FactGrid>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Model routes on this provider stop resolving until a provider with the same slug exists again. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Deleting…" : "Delete provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
