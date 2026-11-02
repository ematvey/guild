//! UsersSection — org users as a searchable, sortable data table; the detail
//! page shows the user as fact cards with explicit edit/delete actions.

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { entityDetailCodec } from "../section-nav";
import { quantizeIso, useCachedGet } from "../use-cached-api";
import { createUser, deleteUser, SETTINGS_PATHS, updateUser, userUsageSeriesPath } from "../../../lib/api/settings";
import { Area, AreaChart } from "recharts";
import { Ellipsis, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import { ChartContainer, type ChartConfig } from "@guild/ui/components/chart";
import { DataTable } from "@guild/ui/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Skeleton, SkeletonForm } from "@guild/ui/components/skeleton";
import { PageHeader } from "../../../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "@guild/ui/components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";

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
    <ChartContainer config={sparkConfig} className="aspect-auto h-7 w-20">
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

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge
      variant="outline"
      className={
        role === "admin"
          ? "border-transparent bg-primary/10 text-primary"
          : "border-transparent bg-accent text-muted-foreground"
      }
    >
      {role}
    </Badge>
  );
}

export default function UsersSection({ detail = null, onDetailChange }: SectionDetailProps) {
  const usersRes = useCachedGet<{ users: UserRow[] }>(SETTINGS_PATHS.users);
  const users = usersRes.data?.users ?? null;
  const error = usersRes.error;
  const reload = usersRes.reload;
  // 30-day per-user spend (one series call, pivoted client-side by email).
  // The upper bound quantizes UP so the inclusive `ts <= to` filter
  // reaches into the current (partial) bucket.
  const seriesPath = useMemo(() => {
    const from = quantizeIso(600_000, Date.now() - 30 * 24 * 3_600_000);
    const to = quantizeIso(600_000, Date.now() + 600_000);
    return userUsageSeriesPath(from, to);
  }, []);
  const seriesRes = useCachedGet<{ rows: SeriesRow[] }>(seriesPath);
  const spend = useMemo(() => {
    const map: Record<string, { points: { bucket: string; cost: number }[]; total: number }> = {};
    for (const row of seriesRes.data?.rows ?? []) {
      const e = map[row.group] ?? { points: [], total: 0 };
      e.points.push({ bucket: row.bucket, cost: row.cost_usd });
      e.total += row.cost_usd;
      map[row.group] = e;
    }
    return map;
  }, [seriesRes.data]);

  const columns = useMemo<ColumnDef<UserRow, any>[]>(
    () => [
      {
        accessorKey: "email",
        header: "Email",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.email}</p>
            <p className="text-xs text-muted-foreground">
              {row.original.identity_type === "password" ? "password sign-in" : row.original.identity_type}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => <RoleBadge role={row.original.role} />,
      },
      {
        id: "spend",
        header: "Spend · 30d",
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-2 tabular-nums text-muted-foreground">
            {seriesRes.data === null && !seriesRes.error ? (
              <Skeleton className="h-3 w-24" />
            ) : seriesRes.error ? (
              <span title={seriesRes.error}>Unavailable</span>
            ) : (
              <SpendSparkline points={spend[row.original.email]?.points ?? []} />
            )}
            {spend[row.original.email] && <span>${spend[row.original.email].total.toFixed(4)}</span>}
          </div>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground pointer-coarse:size-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Ellipsis className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => onDetailChange(row.original.id)}>Open</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [spend, onDetailChange, seriesRes.data, seriesRes.error],
  );

  const view = entityDetailCodec.parse(detail);
  const open = (next: Parameters<typeof entityDetailCodec.format>[0]) => onDetailChange(entityDetailCodec.format(next));

  if (view.kind !== "list") {
    // Deep-linked user page: wait for the list before resolving the id —
    // a not-yet-loaded row would render as the add-user form.
    if (view.kind === "row" && users === null) {
      if (error)
        return (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        );
      return <SkeletonForm />;
    }
    const user = view.kind === "new" ? null : (users?.find((u) => u.id === view.id) ?? null);
    if (view.kind === "row" && !user)
      return <EmptyState title="User not found" hint="It may have been deleted." icon={Users} />;
    return (
      <UserDetail
        user={user}
        onChanged={reload}
        onCreated={(id) => open({ kind: "row", id })}
        onBack={() => {
          reload();
          open({ kind: "list" });
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Users"
        description="Everyone who signs in to this organization."
        actions={
          <Button size="sm" onClick={() => open({ kind: "new" })}>
            <UserPlus className="size-3.5" /> Add user
          </Button>
        }
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={columns}
        data={users}
        search={(u) => `${u.email} ${u.role}`}
        searchPlaceholder="Search users…"
        onRowClick={(u) => open({ kind: "row", id: u.id })}
        empty={
          <EmptyState
            icon={Users}
            title="No users yet"
            hint="Add the first member of the organization."
            action={
              <Button size="sm" onClick={() => open({ kind: "new" })}>
                <UserPlus className="size-3.5" /> Add user
              </Button>
            }
          />
        }
      />
    </div>
  );
}

function UserDetail({
  user,
  onChanged,
  onCreated,
  onBack,
}: {
  user: UserRow | null;
  onChanged: () => void;
  /** Called with the new user id after creation, to land on its own URL. */
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const creating = user === null;
  // Configured users are facts first; editing is an explicit mode.
  const [mode, setMode] = useState<"view" | "edit">(creating ? "edit" : "view");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(user?.role ?? "member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const created = await createUser<{ id: string }>({
          email,
          password,
          role,
        });
        toast.success("User added", { description: email });
        onChanged();
        onCreated(created.id);
      } else {
        const body: Record<string, string> = { role };
        if (password) body.password = password;
        await updateUser(user!.id, body);
        toast.success("User updated", { description: user!.email });
        onChanged();
        setMode("view");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteUser(user!.id);
      toast.success("User deleted", { description: user!.email });
      onChanged();
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  if (creating || mode === "edit") {
    return (
      <div>
        <PageHeader
          title={creating ? "Add user" : "Edit user"}
          description={
            creating
              ? "The user signs in with this email and password."
              : "Change the role or set a new password; leave the password blank to keep the current one."
          }
          back={{ label: "Users", onClick: onBack }}
        />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          {creating && (
            <Field label="Email">
              <Input
                type="email"
                placeholder="user@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          )}
          <Field
            label={creating ? "Password" : "New password"}
            hint={creating ? undefined : "Leave blank to keep the current password."}
          >
            <Input
              type="password"
              placeholder={creating ? "password" : "••••••••"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy || (creating && (!email || !password))} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {!creating && (
              <Button
                variant="ghost"
                onClick={() => {
                  setPassword("");
                  setRole(user!.role);
                  setError(null);
                  setMode("view");
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // view mode: the saved user as facts, with explicit actions
  return (
    <div>
      <PageHeader
        title={user!.email}
        description="Organization user — role and sign-in method below."
        back={{ label: "Users", onClick: onBack }}
        actions={
          <>
            <Button onClick={() => setMode("edit")}>Edit</Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />
      <FactGrid>
        <FactCard label="Role">
          <RoleBadge role={user!.role} />
        </FactCard>
        <FactCard label="Sign-in">{user!.identity_type === "password" ? "password" : user!.identity_type}</FactCard>
      </FactGrid>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              {user!.email} loses access immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Deleting…" : "Delete user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
