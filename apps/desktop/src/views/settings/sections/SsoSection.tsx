//! SsoSection — admin settings for OIDC single sign-on: issuer, client id
//! and client secret against the org's IdP; enabling it puts a "Continue
//! with SSO" button on the sign-in page.

import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
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
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Keep the saved values around so blank secret = keep current. */
  const [savedConfigured, setSavedConfigured] = useState(false);

  const reload = useCallback(() => {
    api<OidcConfig>("GET", "/api/v1/admin/oidc")
      .then((r) => {
        setCfg(r);
        setSavedConfigured(r.configured);
        setIssuer(r.issuer ?? "");
        setClientId(r.client_id ?? "");
        setClientSecret("");
      })
      .catch((e) => {
        setCfg({ configured: false });
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(reload, [reload]);

  const configured = savedConfigured;

  const save = async () => {
    if (busy || !issuer || !clientId) return;
    if (!configured && !clientSecret) return;
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, string> = { issuer, client_id: clientId };
      if (clientSecret) body.client_secret = clientSecret;
      await api("PUT", "/api/v1/admin/oidc", body);
      setSaved(true);
      setSavedConfigured(true);
      setClientSecret("");
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", "/api/v1/admin/oidc");
      setSavedConfigured(false);
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (cfg === null) {
    return (
      <div className="space-y-3 pt-2">
        <Skeleton className="h-24 w-full max-w-xl rounded-lg" />
      </div>
    );
  }

  const redirectUri = `${window.location.origin}/api/v1/auth/oidc/callback`;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Single sign-on (OIDC)</h3>
        <span
          className={`size-2 rounded-full ${configured ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          title={configured ? "configured" : "not configured"}
        />
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {configured
          ? "Configured — the sign-in page offers “Continue with SSO”; users sign in through the org's identity provider."
          : "Not configured — fill in the identity provider details to enable SSO sign-in."}
      </p>

      <div className="max-w-xl space-y-4">
        <div>
          <p className={label}>Issuer URL</p>
          <Input
            className="mt-1.5"
            placeholder="https://idp.example.com/realms/main"
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
            placeholder={configured ? "leave blank to keep the current one" : "client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <p className={label}>Redirect URI (register this at the identity provider)</p>
          <p className="mt-1 break-all font-mono text-xs">{redirectUri}</p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button disabled={busy || !issuer || !clientId || (!configured && !clientSecret)} onClick={save}>
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
          {configured &&
            (confirmRemove ? (
              <>
                <Button variant="destructive" disabled={busy} onClick={remove}>
                  Remove configuration
                </Button>
                <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}
