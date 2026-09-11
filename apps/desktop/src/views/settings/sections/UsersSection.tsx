//! UsersSection — admin settings, integration-style: a list screen of org
//! users plus an "Add user" entry; the detail screen holds role, password
//! reset and delete.

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Pencil, UserPlus } from "lucide-react";
import { Area, AreaChart } from "recharts";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { ChartContainer, type ChartConfig } from "@guild/ui/components/chart";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Input } from "@guild/ui/components/input";

interface UserRow {
  id: string;
  email: string;
  role: string;
  identity_type: string;
}

interface SeriesRow {
  bucket: string;
  group: string; // user email (resolved server-side)
  cost_usd: number;
}

const sparkConfig = {
  cost: { label: "Spend", color: "var(--primary)" },
} satisfies ChartConfig;

/// 30-day daily-cost sparkline; renders nothing when the user has no
/// recorded spend.
function SpendSparkline({ points }: { points: { bucket: string; cost: number }[] }) {
  if (points.length === 0) return null;
  return (
    <ChartContainer config={sparkConfig} className="aspect-auto h-7 w-24">
      <AreaChart data={points} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <Area
          dataKey="cost"
          type="monotone"
          stroke="var(--color-cost)"
          fill="var(--color-cost)"
          fillOpacity={0.25}
          strokeWidth={1}
        />
      </AreaChart>
    </ChartContainer>
  );
}

const roleBadge = (role: string) =>
  role === "admin"
    ? "bg-primary/10 text-primary"
    : "bg-accent text-muted-foreground";

const backBtn =
  "mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export default function UsersSection() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 30-day per-user spend (one series call, pivoted client-side by email).
  const [spend, setSpend] = useState<
    Record<string, { points: { bucket: string; cost: number }[]; total: number }>
  >({});
  /** "new" = add flow; a user id = edit that user; null = list screen. */
  const [detail, setDetail] = useState<"new" | string | null>(null);

  const reload = useCallback(() => {
    api<{ users: UserRow[] }>("GET", "/api/v1/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e) => {
        setUsers([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    const from = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    const to = new Date().toISOString();
    api<{ rows: SeriesRow[] }>(
      "GET",
      `/api/v1/usage/series?group_by=user&bucket=day&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then((r) => {
        const map: Record<
          string,
          { points: { bucket: string; cost: number }[]; total: number }
        > = {};
        for (const row of r.rows) {
          const e = map[row.group] ?? { points: [], total: 0 };
          e.points.push({ bucket: row.bucket, cost: row.cost_usd });
          e.total += row.cost_usd;
          map[row.group] = e;
        }
        setSpend(map);
      })
      .catch(() => setSpend({}));
  }, []);

  useEffect(reload, [reload]);

  if (detail !== null) {
    const user = detail === "new" ? null : users?.find((u) => u.id === detail) ?? null;
    return (
      <UserDetail
        user={user}
        onChanged={reload}
        onBack={() => {
          reload();
          setDetail(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center justify-between">
        <h3 className={label}>Organization users</h3>
        <Button size="sm" onClick={() => setDetail("new")}>
          <UserPlus className="mr-1 size-3.5" /> Add user
        </Button>
      </div>
      {users === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : users.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          No users yet — add the first one.
        </p>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <button
              key={u.id}
              className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40"
              onClick={() => setDetail(u.id)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  {u.identity_type === "password" ? "password sign-in" : u.identity_type}
                </p>
              </div>
              <div
                className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
                title="Spend, last 30 days"
              >
                <SpendSparkline points={spend[u.email]?.points ?? []} />
                {spend[u.email] && (
                  <span className="tabular-nums">${spend[u.email].total.toFixed(4)}</span>
                )}
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${roleBadge(u.role)}`}
              >
                {u.role}
              </span>
              <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserDetail({
  user,
  onChanged,
  onBack,
}: {
  user: UserRow | null;
  onChanged: () => void;
  onBack: () => void;
}) {
  const creating = user === null;
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.role ?? "member");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (busy) return;
    if (creating && (!email || !password)) return;
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        await api("POST", "/api/v1/admin/users", { email, password, role });
        onChanged();
        onBack();
      } else {
        const body: Record<string, string> = { role };
        if (password) body.password = password;
        await api("PUT", `/api/v1/admin/users/${user!.id}`, body);
        setSaved(true);
        onChanged();
        setTimeout(() => setSaved(false), 2000);
      }
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
      await api("DELETE", `/api/v1/admin/users/${user!.id}`);
      onChanged();
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div>
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Users
      </button>
      <h3 className="mb-1 text-base font-semibold">{creating ? "Add user" : email || "…"}</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        {creating
          ? "The user signs in with this email and password."
          : "Change the role or set a new password; blank fields stay unchanged."}
      </p>

      <div className="max-w-xl space-y-4">
        {creating && (
          <div>
            <p className={label}>Email</p>
            <Input
              className="mt-1.5"
              type="email"
              placeholder="user@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        )}
        <div>
          <p className={label}>{creating ? "Password" : "New password"}</p>
          <Input
            className="mt-1.5"
            type="password"
            placeholder={creating ? "password" : "leave blank to keep the current one"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <p className={label}>Role</p>
          <select
            className="mt-1.5 h-9 rounded-md border border-input bg-card px-2 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button disabled={busy || (creating && (!email || !password))} onClick={save}>
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
          {!creating &&
            (confirmDelete ? (
              <>
                <Button variant="destructive" disabled={busy} onClick={remove}>
                  Delete user
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}
