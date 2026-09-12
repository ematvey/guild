//! SsoSection — admin settings for OIDC single sign-on. Clean state machine:
//! "view" when configured (saved facts + Edit/Remove), "edit" when changing
//! an existing config (blank secret = keep current), "new" when configuring
//! from scratch. Enabling it puts a "Continue with SSO" button on the
//! sign-in page.

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Input } from "@guild/ui/components/input";

interface OidcConfig {
  configured: boolean;
  issuer?: string;
  client_id?: string;
}

const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export default function SsoSection() {
  const [cfg, setCfg] = useState<OidcConfig | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<OidcConfig>("GET", "/api/v1/admin/oidc")
      .then((r) => {
        setCfg(r);
        setMode(r.configured ? "view" : "new");
      })
      .catch((e) => {
        setCfg({ configured: false });
        setMode("new");
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(reload, [reload]);

  if (cfg === null) {
    return (
      <div className="space-y-3 pt-2">
        <Skeleton className="h-24 w-full max-w-xl rounded-lg" />
      </div>
    );
  }

  const configured = cfg.configured;

  const header = (
    <div className="mb-1 flex items-center gap-2">
      <KeyRound className="size-4 text-muted-foreground" />
      <h3 className="text-base font-semibold">Single sign-on (OIDC)</h3>
      <span
        className={`size-2 rounded-full ${configured ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
        title={configured ? "configured" : "not configured"}
      />
    </div>
  );

  if (mode === "view" && configured) {
    return (
      <div>
        {header}
        <p className="mb-4 text-xs text-muted-foreground">
          Configured — the sign-in page offers “Continue with SSO”; users sign in
          through the org's identity provider and are provisioned on first login.
        </p>

        <div className="max-w-xl space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className={label}>Issuer URL</p>
            <p className="mt-1 break-all text-base">{cfg.issuer}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className={label}>Client ID</p>
            <p className="mt-1 break-all font-mono text-base">{cfg.client_id}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className={label}>Redirect URI (registered at the identity provider)</p>
            <p className="mt-1 break-all font-mono text-xs">
              {`${window.location.origin}/api/v1/auth/oidc/callback`}
            </p>
          </div>

          {error && <p className="text-base text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button onClick={() => setMode("edit")}>
              <Pencil className="mr-1 size-3.5" /> Edit
            </Button>
            <RemoveButton
              busy={false}
              onRemove={async () => {
                setError(null);
                try {
                  await api("DELETE", "/api/v1/admin/oidc");
                  reload();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  const editing = mode === "edit";
  return (
    <SsoForm
      key={mode + (cfg.issuer ?? "") + (cfg.client_id ?? "")}
      title={editing ? "Edit SSO configuration" : "Configure single sign-on (OIDC)"}
      initialIssuer={editing ? (cfg.issuer ?? "") : ""}
      initialClientId={editing ? (cfg.client_id ?? "") : ""}
      keepSecret={editing}
      onCancel={editing ? () => reload() : undefined}
      onSaved={reload}
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
  onCancel,
  onSaved,
}: {
  title: string;
  initialIssuer: string;
  initialClientId: string;
  keepSecret: boolean;
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
      await api("PUT", "/api/v1/admin/oidc", body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="mb-4 text-base font-semibold">{title}</h3>
      <div className="max-w-xl space-y-4">
        <div>
          <p className={label}>Issuer URL</p>
          <Input
            className="mt-1.5"
            placeholder="https://accounts.google.com"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Discovery runs at {"<issuer>"}/.well-known/openid-configuration.
          </p>
        </div>
        <div>
          <p className={label}>Client ID</p>
          <Input
            className="mt-1.5"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </div>
        <div>
          <p className={label}>Client secret</p>
          <Input
            className="mt-1.5"
            type="password"
            placeholder={keepSecret ? "leave blank to keep the current one" : "client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>

        {error && <p className="text-base text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            disabled={busy || !issuer || !clientId || (!keepSecret && !clientSecret)}
            onClick={save}
          >
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

/// Remove with a two-step confirm, kept as its own tiny component so the
/// confirm state lives and dies with the button.
function RemoveButton({
  busy,
  onRemove,
}: {
  busy: boolean;
  onRemove: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <>
        <Button variant="destructive" disabled={busy} onClick={onRemove}>
          Remove configuration
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(false)}>
          Cancel
        </Button>
      </>
    );
  }
  return (
    <Button
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => setConfirm(true)}
    >
      <Trash2 className="mr-1 size-3.5" /> Remove
    </Button>
  );
}
