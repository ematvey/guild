import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import WebChat from "./views/WebChat";
import { Button } from "@guild/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";
import { Input } from "@guild/ui/components/input";
import { Bot } from "lucide-react";
import { IS_TAURI, apiLogin, apiMe, clearToken, rpcCall, setToken } from "./transport";
import { clearApiCache } from "./views/settings/use-cached-api";
import { clearMachinesCache } from "./views/settings/sections/MachineSection";
import { ThemeProvider, useTheme } from "./theme";
import { ThemedToaster } from "@guild/ui/components/toaster";

const BAKED_URL: string =
  (import.meta as any).env?.VITE_DEFAULT_SERVER_URL ?? "https://guild.example.com";

/// Bound any invoke: a wedged layer below us (daemon, IPC) must surface as
/// an actionable error in the UI, never as an eternal spinner. The invoke
/// itself keeps running in the background; the timer only gives up on it.
function bounded<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function defaultServerUrl(): string {
  try {
    return localStorage.getItem("guild.serverUrl") ?? BAKED_URL;
  } catch {
    return BAKED_URL;
  }
}

/// Web-mode login (chat app served by the guild-server): same-origin auth,
/// session token persisted to localStorage.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <button
      className="rounded-md p-1.5 text-muted-foreground outline-none hover:text-foreground"
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

type Profile = {
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
};

function WebLogin({ onLoggedIn }: { onLoggedIn: (profile: Profile) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ org_id: string } | null>(null);

  // SSO availability is public: the sign-in page offers the IdP button when
  // the org has OIDC configured.
  useEffect(() => {
    fetch("/api/v1/auth/oidc/status")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((v) => {
        if (v?.configured && v?.org_id) setSso({ org_id: v.org_id });
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
          {error && <p className="text-base text-destructive">{error}</p>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          {sso && (
            <>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                variant="outline"
                onClick={
                  () =>
                    (window.location.href = `/api/v1/auth/oidc/login?org_id=${sso.org_id}`)
                }
              >
                Continue with SSO
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/// Tauri (desktop) mode: engine login, then the full agent view.
/// Bottom-right toast shown when a signed update has been downloaded and is
/// waiting; applying happens on the user's restart (VSCode/Zed-style).
function UpdateToast() {
  const [version, setVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    // query first: the download may have finished before the webview loaded
    invoke<string | null>("pending_update_version")
      .then((v) => v && setVersion(v))
      .catch(() => {});
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ version: string }>("update-ready", (e) => setVersion(e.payload.version)),
      listen("update-failed", () => setVersion(null)),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
  }, []);
  if (!version) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg">
      <span className="text-base">
        Update to <span className="font-medium">v{version}</span> ready
      </span>
      <Button
        size="sm"
        disabled={installing}
        onClick={() => {
          setInstalling(true);
          invoke("install_update").catch(() => setInstalling(false));
        }}
      >
        {installing ? "Restarting…" : "Restart to update"}
      </Button>
    </div>
  );
}

function DesktopApp() {
  const [role, setRole] = useState<string>("member");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"pair" | "manual">("pair");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState(defaultServerUrl());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // undefined = auth still resolving (splash screen), null = known logged
  // out, string = logged in. The pair/sign-in card must never flash while
  // the restore is still in flight.
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Surface the build the webview is actually running — pairing hangs are
  // almost always a stale binary or stale background daemon; make the
  // version visible so that's checkable at a glance (web: not a Tauri
  // context, hide it).
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Restore auth on mount (and after F5): the engine keeps the session and
  // persists it to token.json, so ask it instead of assuming logged-out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await bounded(invoke("start_engine"), 30_000, "attach timed out");
        const res = await rpcCall("session.info", {}, 20_000);
        if (cancelled) return;
        if (res?.result?.email) await afterAuth(res.result.email);
        else setUser(null);
      } catch {
        if (!cancelled) setUser(null); // not logged in — show the pair screen
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const afterAuth = async (fallbackEmail: string) => {
    // session.info is the source of truth for the connected server URL and
    // token (works for both pairing and manual login).
    const info = await rpcCall("session.info", {}, 20_000);
    const baseUrl = info.result?.base_url ?? url;
    // Resolve the server profile before entering the shell: the splash holds
    // until the IdP name/avatar are known, so the sidebar never flashes the
    // bare-email fallback. Bounded: an unreachable server must not hang the
    // splash forever — fall back to the bare-email member profile.
    let me: Awaited<ReturnType<typeof apiMe>> = null;
    try {
      me = await bounded(apiMe(), 10_000, "profile lookup timed out");
    } catch {
      /* fall back to member / bare email below */
    }
    setUser(info.result?.email ?? fallbackEmail);
    setRole(me?.role ?? "member");
    setDisplayName(me?.display_name ?? null);
    setAvatarUrl(me?.avatar_url ?? null);
    try {
      localStorage.setItem("guild.serverUrl", baseUrl);
      // Unified shell: the webview talks to the same server over HTTP, so the
      // engine's session token becomes the webview's chat token.
      if (info.result?.token) localStorage.setItem("guild_token", info.result.token);
    } catch {
      /* private mode: pref simply not remembered */
    }
  };

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await bounded(invoke("start_engine"), 30_000,
        "could not attach to the local Guild service. Quit every Guild process (Task Manager, incl. background ones) and reopen the app.");
      const res = await rpcCall("pair", { code: code.trim() }, 45_000);
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
      await bounded(invoke("start_engine"), 30_000,
        "could not attach to the local Guild service. Quit every Guild process (Task Manager, incl. background ones) and reopen the app.");
      const res = await rpcCall("login", { base_url: url, email, password }, 45_000);
      if (res.error) throw new Error(res.error.message ?? "login failed");
      await afterAuth(res.result?.user?.email ?? email);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    // Drop the webview token; the engine keeps its session, so the next
    // restore re-logs-in automatically (full engine sign-out is phase 2).
    clearToken();
    clearApiCache();
    clearMachinesCache();
    setUser(null);
    window.location.reload();
  };

  if (user === undefined) return <Splash />;
  if (user) {
    // Unified shell: the desktop webview runs the same chat UI as the
    // browser, talking HTTP to the same server; only machine-tool execution
    // (and the executor registration that makes it possible) is desktop-
    // specific.
    return (
      <>
        <WebChat
          email={user}
          role={role}
          displayName={displayName}
          avatarUrl={avatarUrl}
          onSignOut={signOut}
        />
        <UpdateToast />
      </>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <UpdateToast />
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
              {error && <p className="text-base text-destructive">{error}</p>}
              <Button onClick={pair} disabled={busy || !code.trim()}>
                {busy ? "Pairing…" : "Pair"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Generate a code in the web app (Settings → Connect desktop app)
              </p>
              <button
                className="text-xs text-muted-foreground outline-none hover:text-foreground"
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
              {error && <p className="text-base text-destructive">{error}</p>}
              <Button onClick={login} disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <button
                className="text-xs text-muted-foreground outline-none hover:text-foreground"
                onClick={() => {
                  setMode("pair");
                  setError(null);
                }}
              >
                use a pairing code instead
              </button>
            </>
          )}
          {appVersion && (
            <p className="text-center text-[11px] text-muted-foreground/70">Guild v{appVersion}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/// Branded full-screen loading state — shown while auth/session resolves.
/// Just the logo, pulsing; no default (logged-out) UI may render before the
/// session state is actually known.
export function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="flex size-14 animate-pulse items-center justify-center rounded-2xl border border-border bg-card">
        <Bot className="size-7 text-muted-foreground" />
      </div>
    </div>
  );
}

function AppInner() {
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string>("member");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (IS_TAURI) {
      // desktop mode: engine-side login happens on submit; nothing to
      // restore here (the engine session is in-memory).
      setReady(true);
      return;
    }
    // web mode: same-origin auth
    // An OIDC callback lands here as #oidc_token=…&email=…; adopt the
    // session and strip the fragment so the token never lingers in the URL.
    if (window.location.hash.startsWith("#oidc_token=")) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const token = params.get("oidc_token");
      if (token) {
        setToken(token);
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
    apiMe()
      .then((u) => {
        setEmail(u?.email ?? null);
        setRole(u?.role ?? "member");
        setDisplayName(u?.display_name ?? null);
        setAvatarUrl(u?.avatar_url ?? null);
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready)
    return <Splash />;

  if (!IS_TAURI) {
    const signOut = () => {
      clearToken();
      clearApiCache();
      clearMachinesCache();
      setEmail(null);
    };
    const onLoggedIn = (profile: Profile) => {
      // The login response carries the full profile; using it directly keeps
      // the role in sync immediately (a later apiMe refresh is unnecessary).
      setEmail(profile.email);
      setRole(profile.role);
      setDisplayName(profile.display_name ?? null);
      setAvatarUrl(profile.avatar_url ?? null);
    };
    return email ? (
      <WebChat
        email={email}
        role={role}
        displayName={displayName}
        avatarUrl={avatarUrl}
        onSignOut={signOut}
      />
    ) : (
      <WebLogin onLoggedIn={onLoggedIn} />
    );
  }
  return <DesktopApp />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
      <ThemedToaster />
    </ThemeProvider>
  );
}
