import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";

interface UserRow {
  id: string;
  email: string;
  role: string;
  identity_type: string;
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ users: UserRow[] }>("GET", "/api/v1/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(reload, [reload]);

  const create = async () => {
    setError(null);
    try {
      await api("POST", "/api/v1/admin/users", { email, password, role });
      setEmail("");
      setPassword("");
      reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const remove = async (id: string) => {
    try {
      await api("DELETE", `/api/v1/admin/users/${id}`);
      reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-56" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input className="w-40" placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="h-9 rounded-md border border-input bg-card px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <Button onClick={create} disabled={!email || !password}>
          Add user
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">email</th>
            <th>role</th>
            <th>identity</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-t border-border">
              <td className="py-2">{u.email}</td>
              <td>{u.role}</td>
              <td className="text-muted-foreground">{u.identity_type}</td>
              <td className="text-right">
                <button className="text-xs text-destructive hover:underline" onClick={() => remove(u.id)}>
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
