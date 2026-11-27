//! SsoSection — OIDC single sign-on. State machine: "view" when configured
//! (saved facts + Edit/Remove), "edit" when changing an existing config
//! (blank secret = keep current), "new" when configuring from scratch.
//! Enabling it puts a "Continue with SSO" button on the sign-in page.

import { serverUrl } from "../../../desktop/src/lib/session";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { deleteOidc, putOidc, SETTINGS_PATHS } from "../../../desktop/src/lib/api/settings";
import { peekCached, useCachedGet } from "../../../desktop/src/views/settings/use-cached-api";
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
import { SkeletonForm } from "@guild/ui/components/skeleton";
import { Input } from "@guild/ui/components/input";
import { PageHeader } from "../../../desktop/src/components/page-header";
import { Field } from "../../../desktop/src/views/settings/components/field";
import { FactCard, FactGrid } from "../../../desktop/src/views/settings/components/fact-card";

interface OidcConfig {
  configured: boolean;
  issuer?: string;
  client_id?: string;
  secret_masked?: string | null;
  /** The redirect URI the server builds from its configured API URL. */
  redirect_uri?: string;
}

export default function SsoSection() {
  const cfgRes = useCachedGet<OidcConfig>(SETTINGS_PATHS.oidc);
  // A failed refresh with nothing cached falls back to the unconfigured flow.
  const cfg = cfgRes.data ?? (cfgRes.error ? { configured: false } : null);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? cfgRes.error;
  const reload = cfgRes.reload;
  const [mode, setMode] = useState<"view" | "edit" | "new" | "remove">(() => {
    const c = peekCached<OidcConfig>(SETTINGS_PATHS.oidc);
    return c ? (c.configured ? "view" : "new") : "view";
  });
  // The fresh fetch landing aligns the mode with the saved config; while the
  // user is mid-session `configured` does not flip (only after a save).
  useEffect(() => {
    if (cfg) setMode(cfg.configured ? "view" : "new");
  }, [cfg?.configured]);

  const remove = async () => {
    setLocalError(null);
    try {
      await deleteOidc();
      toast.success("SSO removed", {
        description: "The sign-in page no longer offers “Continue with SSO”.",
      });
      reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(msg);
      toast.error("Could not remove SSO", { description: msg });
    }
  };

  if (cfg === null) {
    if (cfgRes.error)
      return (
        <p role="alert" className="text-sm text-destructive">
          {cfgRes.error}
        </p>
      );
    return (
      <div className="space-y-3">
        <SkeletonForm />
      </div>
    );
  }

  const configured = cfg.configured;

  if (configured && (mode === "view" || mode === "remove")) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Single sign-on (OIDC)"
          description="Configured — the sign-in page offers “Continue with SSO”; users sign in through the org's identity provider and are provisioned on first login."
          actions={
            <>
              <Button onClick={() => setMode("edit")}>Edit</Button>
              <Button variant="outline" className="text-destructive" onClick={() => setMode("remove")}>
                Remove
              </Button>
            </>
          }
        />
        <FactGrid>
          <FactCard label="Issuer URL">
            <p className="break-all text-sm">{cfg.issuer}</p>
          </FactCard>
          <FactCard label="Client ID">
            <p className="break-all font-mono text-sm">{cfg.client_id}</p>
          </FactCard>
          <FactCard label="Redirect URI (registered at the identity provider)" className="sm:col-span-2">
            <p className="break-all font-mono text-sm">
              {cfg.redirect_uri ?? `${serverUrl()}/api/v1/auth/oidc/callback`}
            </p>
          </FactCard>
        </FactGrid>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <SsoRemoveDialog
          open={mode === "remove"}
          onOpenChange={(open) => {
            if (!open) setMode("view");
          }}
          onRemove={remove}
        />
      </div>
    );
  }

  const editing = mode === "edit";
  return (
    <SsoForm
      key={mode + (cfg.issuer ?? "") + (cfg.client_id ?? "")}
      title={editing ? "Edit SSO configuration" : "Single sign-on (OIDC)"}
      initialIssuer={editing ? (cfg.issuer ?? "") : ""}
      initialClientId={editing ? (cfg.client_id ?? "") : ""}
      keepSecret={editing}
      secretMasked={editing ? cfg.secret_masked : null}
      onCancel={
        editing
          ? () => {
              reload();
              setMode("view");
            }
          : undefined
      }
      onSaved={() => {
        reload();
        setMode("view");
      }}
    />
  );
}

/// The issuer / client-id / client-secret form. Used for "new" (all fields
/// required) and "edit" (blank secret = keep the current one).
function SsoForm({
  title,
  initialIssuer,
  initialClientId,
  keepSecret,
  secretMasked,
  onCancel,
  onSaved,
}: {
  title: string;
  initialIssuer: string;
  initialClientId: string;
  keepSecret: boolean;
  secretMasked?: string | null;
  onCancel?: () => void;
  onSaved: () => void;
}) {
  const [issuer, setIssuer] = useState(initialIssuer);
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy || !issuer || !clientId) return;
    if (!keepSecret && !clientSecret) return;
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, string> = { issuer, client_id: clientId };
      if (clientSecret) body.client_secret = clientSecret;
      await putOidc(body);
      toast.success("SSO configuration saved");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={title}
        description="Users sign in through the org's identity provider and are provisioned on first login."
        back={onCancel ? { label: "Back to SSO", onClick: onCancel } : undefined}
      />
      <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
        <Field label="Issuer URL" hint={"Discovery runs at <issuer>/.well-known/openid-configuration."}>
          <Input placeholder="https://accounts.google.com" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </Field>
        <Field label="Client ID">
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label="Client secret" hint={keepSecret ? "Leave blank to keep the current one." : undefined}>
          <Input
            type="password"
            placeholder={keepSecret ? (secretMasked ?? "••••••••") : "client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button disabled={busy || !issuer || !clientId || (!keepSecret && !clientSecret)} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/// Confirmation dialog for removing the SSO configuration; state lives and
/// dies with this component.
function SsoRemoveDialog({
  open,
  onOpenChange,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove SSO configuration?</AlertDialogTitle>
          <AlertDialogDescription>
            The sign-in page drops the “Continue with SSO” button; users fall back to password sign-in. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onRemove();
              setBusy(false);
              onOpenChange(false);
            }}
          >
            {busy ? "Removing…" : "Remove configuration"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
