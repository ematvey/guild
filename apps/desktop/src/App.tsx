import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AgentView from "./views/AgentView";
import WebChat from "./views/WebChat";
import { Input } from "./components/input";
import { Button } from "./components/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/card";
import { IS_TAURI, apiLogin, apiMe, clearToken } from "./transport";

const BAKED_URL: string =
  (import.meta as any).env?.VITE_DEFAULT_SERVER_URL ?? "http://localhost:18080";

function defaultServerUrl(): string {
  try {
    return localStorage.getItem("guild.serverUrl") ?? BAKED_URL;
  } catch {
    return BAKED_URL;
  }
}

/// Web-mode login (chat app served by the guild-server): same-origin auth,
/// token shared with the /admin console via localStorage.
function WebLogin({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = await apiLogin(defaultServerUrl(), email, password);
      onLoggedIn(user.email);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Guild</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-xs text-neutral-500">
            Admin console:{" "}
            <a className="underline decoration-neutral-600" href="/admin/">
              /admin
            </a>{" "}
            (same account)
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/// Tauri (desktop) mode: engine login, then the full agent view. The admin
/// console opens in the system browser with a token handoff (fragment).
function DesktopApp() {
  const [url, setUrl] = useState(defaultServerUrl());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [adminUrl, setAdminUrl] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("start_engine");
      const res = await invoke<any>("rpc_request", {
        method: "login",
        params: { base_url: url, email, password },
      });
      if (res.error) throw new Error(res.error.message ?? "login failed");
      setUser(res.result?.user?.email ?? email);
      try {
        localStorage.setItem("guild.serverUrl", url);
      } catch {
        /* private mode: pref simply not remembered */
      }
      // admin console handoff: token travels in the URL fragment (never sent
      // to the server); the console picks it up and stores it locally.
      const info = await invoke<any>("rpc_request", { method: "session.info", params: {} });
      if (info.result?.token) {
        setAdminUrl(
          `${url.replace(/\/$/, "")}/admin/#tk=${info.result.token}`,
        );
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return user ? (
    <AgentView email={user} adminUrl={adminUrl} />
  ) : (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Guild</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button onClick={login} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (IS_TAURI) {
      // desktop mode: engine-side login happens on submit; nothing to
      // restore here (the engine session is in-memory).
      setReady(true);
      return;
    }
    // web mode: same-origin auth shared with /admin
    apiMe()
      .then((u) => setEmail(u?.email ?? null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="p-8 text-neutral-400">Loading…</div>;

  if (!IS_TAURI) {
    const signOut = () => {
      clearToken();
      setEmail(null);
    };
    return email ? <WebChat email={email} onSignOut={signOut} /> : <WebLogin onLoggedIn={setEmail} />;
  }
  return <DesktopApp />;
}
