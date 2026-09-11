//! UsersSection — admin settings:
//! list org users, create a user (email + password + role), delete with
//! confirm.

import { useCallback, useEffect, useState } from "react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";

interface UserRow {
  id: string;
  email: string;
  role: string;
  identity_type: string;
}

const roleBadge = (role: string) =>
  role === "admin"
    ? "bg-primary/10 text-primary"
    : "bg-accent text-muted-foreground";

export default function UsersSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    api<{ users: UserRow[] }>("GET", "/api/v1/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e) => {
        setUsers([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(reload, [reload]);

  const create = async () => {
    if (!email || !password || creating) return;
    setError(null);
    setCreating(true);
    try {
      await api("POST", "/api/v1/admin/users", { email, password, role });
      setEmail("");
      setPassword("");
      setRole("member");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (u: UserRow) => {
    if (!window.confirm(`Delete user ${u.email}? This cannot be undone.`)) return;
    setError(null);
    setDeletingId(u.id);
    try {
      await api("DELETE", `/api/v1/admin/users/${u.id}`);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* create user */}
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Add user
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            className="w-56"
            placeholder="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            className="w-44"
            placeholder="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <Button onClick={create} disabled={!email || !password || creating}>
            {creating ? "Adding…" : "Add user"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The user signs in with this email and password.
        </p>
      </div>

      {/* user list */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Organization users
          </p>
        </div>
        {users === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 w-full animate-pulse rounded-md bg-accent" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No users yet.</p>
        ) : (
          <ul>
            {users.map((u) => (
              <li
                key={u.id}
                className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{u.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.identity_type === "password" ? "password sign-in" : u.identity_type}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${roleBadge(u.role)}`}
                >
                  {u.role}
                </span>
                <button
                  className="text-xs text-destructive hover:underline disabled:opacity-50"
                  disabled={deletingId === u.id}
                  onClick={() => remove(u)}
                >
                  {deletingId === u.id ? "deleting…" : "delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
