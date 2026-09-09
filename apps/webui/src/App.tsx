import { useEffect, useState } from "react";
import { clearToken, getToken, me, type UserInfo } from "./api";
import Login from "./views/Login";
import Dashboard from "./views/Dashboard";
import Users from "./views/Users";
import Registry from "./views/Registry";
import Gateway from "./views/Gateway";
import Chat from "./views/Chat";
import Downloads from "./views/Downloads";

const VIEWS = ["dashboard", "chat", "downloads", "users", "registry", "gateway"] as const;

function currentView(): string {
  const h = window.location.hash.replace("#/", "");
  return VIEWS.includes(h as (typeof VIEWS)[number]) ? h : "dashboard";
}

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [view, setView] = useState(currentView());
  const [ready, setReady] = useState(false);

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

  if (!ready) return <div className="p-8 text-neutral-400">Loading…</div>;
  if (!user) return <Login onLoggedIn={() => void me().then(setUser)} />;

  const isAdmin = user.role === "admin";
  const nav: [string, string][] = [
    ["dashboard", "Usage"],
    ["chat", "Chat"],
    ["downloads", "Downloads"],
    ...(isAdmin ? ([["users", "Users"], ["registry", "Registry"], ["gateway", "Gateway"]] as [string, string][]) : []),
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2 text-sm">
        <span className="font-medium">Guild</span>
        {nav.map(([id, label]) => (
          <a
            key={id}
            href={`#/${id}`}
            className={view === id ? "text-neutral-100 underline" : "text-neutral-500 hover:text-neutral-300"}
          >
            {label}
          </a>
        ))}
        <span className="ml-auto text-neutral-500">{user.email}</span>
        <button
          className="text-xs text-neutral-500 hover:text-neutral-300"
          onClick={() => {
            clearToken();
            setUser(null);
          }}
        >
          sign out
        </button>
      </header>
      {view === "dashboard" && <Dashboard />}
      {view === "chat" && <Chat />}
      {view === "downloads" && <Downloads />}
      {view === "users" && isAdmin && <Users />}
      {view === "registry" && isAdmin && <Registry />}
      {view === "gateway" && isAdmin && <Gateway />}
    </div>
  );
}
