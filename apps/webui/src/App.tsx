import { useEffect, useState } from "react";
import { clearToken, getToken, me, setToken, type UserInfo } from "./api";
import { ThemeProvider, useTheme } from "./theme";
import Login from "./views/Login";
import Dashboard from "./views/Dashboard";
import Users from "./views/Users";
import Registry from "./views/Registry";
import Gateway from "./views/Gateway";
import Integrations from "./views/Integrations";

import Downloads from "./views/Downloads";

function ThemeToggle() {
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

const VIEWS = ["dashboard", "downloads", "users", "registry", "gateway", "integrations"] as const;

function currentView(): string {
  const h = window.location.hash.replace("#/", "");
  return VIEWS.includes(h as (typeof VIEWS)[number]) ? h : "dashboard";
}

function AppInner() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [view, setView] = useState(currentView());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Desktop-app handoff: #tk=<session token> (URL fragment — never sent to
    // the server). Store it, strip it, continue to the requested view.
    const h = window.location.hash;
    if (h.startsWith("#tk=")) {
      const rest = h.slice(4);
      const [token, next] = rest.split("#");
      if (token) {
        setToken(token);
        window.location.hash = next ? `#${next}` : "#/dashboard";
        setView(next ? next.replace(/^\//, "") : "dashboard");
        return;
      }
    }
  }, []);

  useEffect(() => {
    const onHash = () => setView(currentView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    me()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!user) return <Login onLoggedIn={() => void me().then(setUser)} />;

  const isAdmin = user.role === "admin";
  const nav: [string, string][] = [
    ["dashboard", "Usage"],
    ["downloads", "Downloads"],
    ...(isAdmin ? ([["users", "Users"], ["registry", "Registry"], ["gateway", "Gateway"], ["integrations", "Integrations"]] as [string, string][]) : []),
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-4 border-b border-border px-4 py-2 text-sm">
        <span className="font-medium">
          <a href="/" className="hover:text-foreground" title="Back to the chat app">
            Guild
          </a>
        </span>
        {nav.map(([id, label]) => (
          <a
            key={id}
            href={`#/${id}`}
            className={view === id ? "text-foreground underline" : "text-muted-foreground hover:text-foreground"}
          >
            {label}
          </a>
        ))}
        <ThemeToggle />
        <span className="ml-auto text-muted-foreground">{user.email}</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            clearToken();
            setUser(null);
          }}
        >
          sign out
        </button>
      </header>
      {view === "dashboard" && <Dashboard />}

      {view === "downloads" && <Downloads />}
      {view === "users" && isAdmin && <Users />}
      {view === "registry" && isAdmin && <Registry />}
      {view === "gateway" && isAdmin && <Gateway />}
      {view === "integrations" && isAdmin && <Integrations />}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
