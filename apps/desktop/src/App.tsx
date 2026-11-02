import { beginOidcLogin } from "./lib/oidc-login";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Thread from "./views/thread/Thread";
import { consumeAuthFragment, writeAddress } from "./views/thread/route";
import { InstallPrompt } from "./views/onboarding";
import { Button } from "@guild/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@guild/ui/components/card";
import { Input } from "@guild/ui/components/input";
import { HAS_ENGINE, HAS_SHELL, SERVER_URL_KEY, clearToken, setToken } from "./lib/session";
import { apiLogin, apiLogout, apiMe } from "./lib/api/servers";
import { request } from "./lib/api/request";
import { timeoutAfter } from "./lib/timeout";
import { machineId, rpcCall } from "./lib/machine-rpc";
import { toast } from "sonner";
import { ThemeProvider } from "./theme";
import { resetSessionState } from "./lib/session-reset";
import { ThemedToaster } from "@guild/ui/components/toaster";

const BAKED_URL: string = (import.meta as any).env?.VITE_DEFAULT_SERVER_URL ?? "https://guild.example.com";

function defaultServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_URL_KEY) ?? BAKED_URL;
  } catch {
    return BAKED_URL;
  }
}

/// Web-mode login (chat app served by the guild-server): same-origin auth,
/// session token persisted to localStorage.

type Profile = {
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
  onboarded?: boolean;
};

function WebLogin({ onLoggedIn }: { onLoggedIn: (profile: Profile) => void }) {
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
          <CardTitle className="text-xl">Guild</CardTitle>
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
    // every page load (F5, navigation) asks the server immediately — the
    // 15-minute Rust timer only covers long-lived sessions
    invoke("check_update_now").catch(() => {});
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<{ version: string }>("update-ready", (e) => setVersion(e.payload.version)),
      listen("update-failed", () => setVersion(null)),
    ];
    return () => {
      for (const p of unlisteners) p.then((u) => u()).catch(() => {});
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

/** The server a pasted pairing code (`g1|<url>|<secret>`) sends the
 *  session to, shown before Pair; `insecure` is plain http to a
 *  non-loopback host, which the engine refuses without its override. */
function pairingTarget(code: string): { host: string; insecure: boolean } | null {
  const parts = code.trim().split("|");
  if (parts.length !== 3 || parts[0] !== "g1") return null;
  try {
    const url = new URL(parts[1]!);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
    return { host: url.host, insecure: url.protocol === "http:" && !loopback };
  } catch {
    return null;
  }
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
  // Multi-workspace: showing the pair/sign-in card over the running app to
  // add a second server. The card's success path reloads (the new workspace
  // is active; the restore path re-points everything).
  const [addWorkspace, setAddWorkspace] = useState(false);

  /** Opens the pair/sign-in card. A base_url (from a dead-token workspace
   * row) prefills the manual form so re-auth hits that same server, which
   * the daemon's login adopts-or-replaces — no duplicate row. */
  const openAddWorkspace = (baseUrl?: string) => {
    if (baseUrl) {
      setMode("manual");
      setUrl(baseUrl);
      setEmail("");
      setPassword("");
    }
    setError(null);
    setAddWorkspace(true);
  };

  // Surface the build the webview is actually running — pairing hangs are
  // almost always a stale binary or stale background daemon; make the
  // version visible so that's checkable at a glance (web: not a Tauri
  // context, hide it).
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // Restore auth on mount (and after F5): the engine keeps the session and
  // persists it to token.json, so ask it instead of assuming logged-out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await timeoutAfter(invoke("start_engine"), 30_000, "attach timed out");
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
    // The restore runs once per app start; afterAuth reads the state of the
    // render that started it, which is the initial one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const afterAuth = async (fallbackEmail: string) => {
    // session.info is the source of truth for the connected server URL and
    // token (works for both pairing and manual login).
    const info = await rpcCall("session.info", {}, 20_000);
    const baseUrl = info.result?.base_url ?? url;
    // Machine identity: the daemon's executor link (machine WS + tool
    // execution) keys on the webview's stable per-install id — report it
    // after every auth so the link connects. Desktop only (browsers have
    // no daemon socket). Pair/login already carried the id, so this is the
    // restore/refresh path — but a failure here means the machine never
    // registers and project creation fails with "unknown machine", so it
    // must be visible, never swallowed.
    if (HAS_ENGINE) {
      try {
        await rpcCall("machine.identify", { machine_id: machineId() }, 10_000);
      } catch {
        toast.warning(
          "This computer didn't register with the server — creating projects here will fail until it does. Quit every Guild process (incl. background ones) and reopen the app.",
          { duration: 10_000 },
        );
      }
    }
    // Adopt the new server/token before resolving the profile: apiMe reads
    // both from localStorage, so a profile read first would carry the old
    // or missing credential and land a fresh admin login on the member
    // fallback.
    try {
      localStorage.setItem(SERVER_URL_KEY, baseUrl);
      // Unified shell: the webview talks to the same server over HTTP, so the
      // engine's session token becomes the webview's chat token.
      if (info.result?.token) setToken(info.result.token);
    } catch {
      /* private mode: pref simply not remembered */
    }
    // Resolve the server profile before entering the shell: the splash holds
    // until the IdP name/avatar are known, so the sidebar never flashes the
    // bare-email fallback. Bounded: an unreachable server must not hang the
    // splash forever — fall back to the bare-email member profile.
    let me: Awaited<ReturnType<typeof apiMe>> = null;
    try {
      me = await timeoutAfter(apiMe(), 10_000, "profile lookup timed out");
    } catch {
      /* fall back to member / bare email below */
    }
    setUser(info.result?.email ?? fallbackEmail);
    setRole(me?.role ?? "member");
    setDisplayName(me?.display_name ?? null);
    setAvatarUrl(me?.avatar_url ?? null);
  };

  const pairTarget = pairingTarget(code);
  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      await timeoutAfter(
        invoke("start_engine"),
        30_000,
        "could not attach to the local Guild service. Quit every Guild process (Task Manager, incl. background ones) and reopen the app.",
      );
      const res = await rpcCall("pair", { code: code.trim(), machine_id: machineId() }, 45_000);
      if (res.error) throw new Error(res.error.message ?? "pairing failed");
      if (addWorkspace) {
        setBusy(false);
        window.location.reload();
        return;
      }
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
      await timeoutAfter(
        invoke("start_engine"),
        30_000,
        "could not attach to the local Guild service. Quit every Guild process (Task Manager, incl. background ones) and reopen the app.",
      );
      const res = await rpcCall("login", { base_url: url, email, password, machine_id: machineId() }, 45_000);
      if (res.error) throw new Error(res.error.message ?? "login failed");
      if (addWorkspace) {
        setBusy(false);
        window.location.reload();
        return;
      }
      await afterAuth(res.result?.user?.email ?? email);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    // Full sign-out: end the engine's session (and its persisted token),
    // then drop the webview token. The next restore shows the pair/sign-in
    // screen instead of re-logging in silently. If the engine is
    // unreachable we still sign the webview out — the stale token.json
    // cannot survive a 401 on the next restore.
    try {
      await timeoutAfter(invoke("start_engine"), 30_000, "attach timed out");
      await rpcCall("session.clear", {}, 20_000);
    } catch {
      /* engine unreachable — local sign-out only */
    }
    clearToken();
    resetSessionState();
    setUser(null);
    window.location.reload();
  };

  if (user === undefined) return <BootBackground />;
  if (user && !addWorkspace) {
    // Unified shell: the desktop webview runs the same chat UI as the
    // browser, talking HTTP to the same server; only machine-tool execution
    // (and the executor registration that makes it possible) is desktop-
    // specific.
    return (
      <>
        <Thread
          email={user}
          role={role}
          displayName={displayName}
          avatarUrl={avatarUrl}
          onSignOut={signOut}
          onAddWorkspace={openAddWorkspace}
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
          <CardTitle className="text-xl">{addWorkspace ? "Add workspace" : "Guild"}</CardTitle>
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
              {pairTarget && (
                <p className={`text-xs ${pairTarget.insecure ? "text-destructive" : "text-muted-foreground"}`}>
                  Pairs with <span className="font-medium">{pairTarget.host}</span>
                  {pairTarget.insecure &&
                    " over unencrypted http — refused unless GUILD_ALLOW_INSECURE_PAIRING=1. Only pair with a server you trust."}
                </p>
              )}
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
              <Input
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && login()}
              />
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
          {appVersion && <p className="text-center text-xs text-muted-foreground/70">Guild v{appVersion}</p>}
          {addWorkspace && (
            <button
              className="text-xs text-muted-foreground outline-none hover:text-foreground"
              onClick={() => {
                setAddWorkspace(false);
                setError(null);
              }}
            >
              back to the current workspace
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/// Plain full-screen background for the interval before auth/session state is
/// known: no indicator and no default (logged-out) UI may render first.
function BootBackground() {
  return <div className="min-h-screen bg-background" />;
}

function AppInner() {
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string>("member");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Onboarding: the server flags users who finished (or skipped) the
  // first-run wizard; absent on older payloads = treated as done.
  const [onboarded, setOnboarded] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (HAS_ENGINE) {
      // desktop mode: engine-side login happens on submit; nothing to
      // restore here (the engine session is in-memory).
      setReady(true);
      return;
    }
    // web mode: same-origin auth
    // An OIDC callback lands here as #oidc_token=…&email=…; adopt the
    // session and strip the fragment so the token never lingers in the URL.
    const callback = consumeAuthFragment(window.location);
    if (callback) {
      writeAddress(callback.canonicalUrl, { replace: true });
      if (callback.token) setToken(callback.token);
    }
    apiMe()
      .then((u) => {
        setEmail(u?.email ?? null);
        setRole(u?.role ?? "member");
        setDisplayName(u?.display_name ?? null);
        setAvatarUrl(u?.avatar_url ?? null);
        setOnboarded(u?.onboarded ?? true);
      })
      // An unreachable server reads as signed out: the login screen shows.
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <BootBackground />;

  if (!HAS_ENGINE) {
    const signOut = async () => {
      await apiLogout();
      clearToken();
      resetSessionState();
      setEmail(null);
    };
    const onLoggedIn = (profile: Profile) => {
      // The login response carries the full profile; using it directly keeps
      // the role in sync immediately (a later apiMe refresh is unnecessary).
      setEmail(profile.email);
      setRole(profile.role);
      setDisplayName(profile.display_name ?? null);
      setAvatarUrl(profile.avatar_url ?? null);
      setOnboarded(profile.onboarded ?? true);
    };
    return email ? (
      <Thread
        email={email}
        role={role}
        displayName={displayName}
        avatarUrl={avatarUrl}
        onSignOut={signOut}
        onboarded={onboarded}
        onOnboarded={() => setOnboarded(true)}
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
      {/* One prompt for every web screen — signed out, thread, guide. The
          desktop app has no install step, so it never renders it. */}
      {!HAS_SHELL && <InstallPrompt />}
      <ThemedToaster />
    </ThemeProvider>
  );
}
