import { useEffect, useState } from "react";
import { Button } from "@guild/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";
import { Input } from "@guild/ui/components/input";
import { beginOidcLogin } from "../lib/oidc-login";
import { apiLogin } from "../lib/api/servers";
import { request } from "../lib/api/request";

/// Web-mode login (chat app served by the guild-server): same-origin auth,
/// session token persisted to localStorage.

export type Profile = {
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
  onboarded?: boolean;
};

export function WebLogin({ onLoggedIn, title = "Guild" }: { onLoggedIn: (profile: Profile) => void; title?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ org_id: string } | null>(null);
  // SSO-first sign-in: the password form stays hidden until the user asks
  // for it, so the IdP button is the only default path.
  const [showPassword, setShowPassword] = useState(false);

  // SSO availability is public: the sign-in page offers the IdP button when
  // the org has OIDC configured.
  useEffect(() => {
    request<{ configured?: boolean; org_id?: string }>("GET", "/api/v1/auth/oidc/status")
      .then((v) => {
        if (v?.configured && v.org_id) setSso({ org_id: v.org_id });
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // web mode is always same-origin (served by guild-server); an absolute
      // default would go cross-origin when tunneled (e.g. Moshi) and trip CORS
      const user = await apiLogin(window.location.origin, email, password);
      onLoggedIn(user);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          {title === "Guild" && (
            <span className="mb-2 grid size-10 place-items-center rounded-lg border border-border bg-muted">
              <img src="/brand/guild-icon-light.svg" className="size-6 dark:hidden" alt="" />
              <img src="/brand/guild-icon-dark.svg" className="hidden size-6 dark:block" alt="" />
            </span>
          )}
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {sso && !showPassword ? (
            <>
              <Button onClick={() => (window.location.href = beginOidcLogin(sso.org_id))}>Continue with SSO</Button>
              <button
                className="text-center text-xs text-muted-foreground outline-none hover:text-foreground"
                onClick={() => setShowPassword(true)}
              >
                Use login and password
              </button>
            </>
          ) : (
            <>
              <Input
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <Input
                placeholder="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              {error && <p className="text-base text-destructive">{error}</p>}
              <Button onClick={submit} disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              {sso && (
                <button
                  className="text-center text-xs text-muted-foreground outline-none hover:text-foreground"
                  onClick={() => {
                    setShowPassword(false);
                    setError(null);
                  }}
                >
                  Use SSO instead
                </button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
