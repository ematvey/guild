import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AgentView from "./views/AgentView";
import WebChat from "./views/WebChat";
import { Button } from "@guild/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";
import { Input } from "@guild/ui/components/input";
import { Bot } from "lucide-react";
import { IS_TAURI, apiLogin, apiMe, clearToken } from "./transport";
import { ThemeProvider, useTheme } from "./theme";

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
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button
      className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}

function WebLogin({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // web mode is always same-origin (served by guild-server); an absolute
      // default would go cross-origin when tunneled (e.g. Moshi) and trip CORS
      const user = await apiLogin(window.location.origin, email, password);
      onLoggedIn(user.email);
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/// Tauri (desktop) mode: engine login, then the full agent view. The admin
/// console opens in the system browser with a token handoff (fragment).
function DesktopApp() {
  const [mode, setMode] = useState<"pair" | "manual">("pair");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState(defaultServerUrl());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [adminUrl, setAdminUrl] = useState<string | null>(null);

  const afterAuth = async (fallbackEmail: string) => {
    // session.info is the source of truth for the connected server URL and
    // token (works for both pairing and manual login).
    const info = await invoke<any>("rpc_request", { method: "session.info", params: {} });
    const baseUrl = info.result?.base_url ?? url;
    setUser(info.result?.email ?? fallbackEmail);
    try {
      localStorage.setItem("guild.serverUrl", baseUrl);
    } catch {
      /* private mode: pref simply not remembered */
    }
    // admin console handoff: token travels in the URL fragment (never sent
    // to the server); the console picks it up and stores it locally.
    if (info.result?.token) {
      setAdminUrl(`${baseUrl.replace(/\/$/, "")}/admin/#tk=${info.result.token}`);
    }
  };

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("start_engine");
      const res = await invoke<any>("rpc_request", {
        method: "pair",
        params: { code: code.trim() },
      });
      if (res.error) throw new Error(res.error.message ?? "pairing failed");
      await afterAuth(res.result?.user?.email ?? "");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

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
      await afterAuth(res.result?.user?.email ?? email);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return <AgentView email={user} adminUrl={adminUrl} />;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Guild</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mode === "pair" ? (
            <>
              <Input
                placeholder="Paste pairing code (g1|…|…)"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && code.trim() && pair()}
                autoFocus
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={pair} disabled={busy || !code.trim()}>
                {busy ? "Pairing…" : "Pair"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Generate a code in the web app (Settings → Connect desktop app)
              </p>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setMode("manual");
                  setError(null);
                }}
              >
                or sign in with server, email and password
              </button>
            </>
          ) : (
            <>
              <Input placeholder="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
              <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Input
                placeholder="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && login()}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={login} disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setMode("pair");
                  setError(null);
                }}
              >
                use a pairing code instead
              </button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/// Branded full-screen loading state — shown while auth/session resolves.
export function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <div className="flex size-14 animate-pulse items-center justify-center rounded-2xl border border-border bg-card">
        <Bot className="size-7 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">Loading Guild…</p>
    </div>
  );
}

function AppInner() {
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

  if (!ready)
    return <Splash />;

  if (!IS_TAURI) {
    const signOut = () => {
      clearToken();
      setEmail(null);
    };
    return email ? <WebChat email={email} onSignOut={signOut} /> : <WebLogin onLoggedIn={setEmail} />;
  }
  return <DesktopApp />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
