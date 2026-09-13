//! TeamsSection — org teams as a data table; the detail page shows the team
//! with a members table, add-member row, rename and delete actions.

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { Plus, Trash2, UsersRound, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../admin-api";
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
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";

interface TeamRow {
  id: string;
  name: string;
  member_count: number;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
}

export default function TeamsSection({ detail = null, onDetailChange }: SectionDetailProps) {
  const teamsRes = useCachedGet<{ teams: TeamRow[] }>("/api/v1/admin/teams");
  const teams = teamsRes.data?.teams ?? null;
  const error = teamsRes.error;
  const reload = teamsRes.reload;

  const columns = useMemo<ColumnDef<TeamRow, any>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Team",
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <UsersRound className="size-4 text-muted-foreground" />
            <span className="font-medium">{row.original.name}</span>
          </div>
        ),
      },
      {
        accessorKey: "member_count",
        header: "Members",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.member_count === 1 ? "1 member" : `${row.original.member_count} members`}
          </span>
        ),
      },
    ],
    [],
  );

  if (detail !== null) {
    // Deep-linked team page: wait for the list before resolving the id —
    // a not-yet-loaded row would render as the add-team form.
    if (detail !== "new" && teams === null) {
      return <Skeleton className="h-24 w-full rounded-lg" />;
    }
    const team = detail === "new" ? null : teams?.find((t) => t.id === detail) ?? null;
    return (
      <TeamDetail
        team={team}
        onChanged={reload}
        onCreated={(id) => onDetailChange(id)}
        onBack={() => {
          reload();
          onDetailChange(null);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Teams"
        description="Teams group users inside the organization."
        actions={
          <Button size="sm" onClick={() => onDetailChange("new")}>
            <Plus className="size-3.5" /> Add team
          </Button>
        }
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={columns}
        data={teams}
        search={(t) => t.name}
        searchPlaceholder="Search teams…"
        onRowClick={(t) => onDetailChange(t.id)}
        empty={
          <EmptyState
            icon={UsersRound}
            title="No teams yet"
            hint="Create a team to group users for model routes and approvals."
            action={
              <Button size="sm" onClick={() => onDetailChange("new")}>
                <Plus className="size-3.5" /> Add team
              </Button>
            }
          />
        }
      />
    </div>
  );
}

function TeamDetail({
  team,
  onChanged,
  onCreated,
  onBack,
}: {
  team: TeamRow | null;
  onChanged: () => void;
  /** Called with the new team id after creation, to land on its own URL. */
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const creating = team === null;
  // The saved team is facts first; renaming is an explicit edit mode.
  const [mode, setMode] = useState<"view" | "edit">(creating ? "edit" : "view");
  const [name, setName] = useState(team?.name ?? "");
  const [addUserId, setAddUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const membersRes = useCachedGet<{ members: UserRow[] }>(
    creating ? null : `/api/v1/admin/teams/${team!.id}/members`,
  );
  const members = creating ? [] : (membersRes.data?.members ?? null);
  const orgUsers = useCachedGet<{ users: UserRow[] }>("/api/v1/admin/users").data?.users ?? null;

  const save = async () => {
    if (busy || !name) return;
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        const created = await api<{ id: string }>("POST", "/api/v1/admin/teams", { name });
        toast.success("Team created", { description: name });
        onChanged();
        onCreated(created.id);
      } else {
        await api("PUT", `/api/v1/admin/teams/${team!.id}`, { name });
        toast.success("Team renamed", { description: name });
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

  const addMember = async () => {
    if (!addUserId || busy) return;
    setError(null);
    setBusy(true);
    try {
      const added = addable.find((u) => u.id === addUserId);
      await api("POST", `/api/v1/admin/teams/${team!.id}/members`, {
        user_id: addUserId,
      });
      toast.success("Member added", { description: added?.email });
      setAddUserId("");
      membersRes.reload();
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not add member", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (user: UserRow) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("DELETE", `/api/v1/admin/teams/${team!.id}/members/${user.id}`);
      toast.success("Member removed", { description: user.email });
      membersRes.reload();
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not remove member", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const removeTeam = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/api/v1/admin/teams/${team!.id}`);
      toast.success("Team deleted", { description: team!.name });
      onChanged();
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.id));
  const addable = (orgUsers ?? []).filter((u) => !memberIds.has(u.id));

  if (creating || mode === "edit") {
    return (
      <div>
        <PageHeader
          title={creating ? "Add team" : "Edit team"}
          description={
            creating
              ? "Name the team; members are managed after creation."
              : "Rename the team; members are managed on the team page."
          }
          back={{ label: "Teams", onClick: onBack }}
        />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          <Field label="Team name">
            <Input
              placeholder="e.g. platform"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy || !name} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {!creating && (
              <Button
                variant="ghost"
                onClick={() => {
                  setName(team!.name);
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

  // view mode: the saved team as facts, members managed in place
  return (
    <div className="space-y-5">
      <PageHeader
        title={team?.name || "…"}
        description="Members of this team. Adding or removing takes effect immediately."
        back={{ label: "Teams", onClick: onBack }}
        actions={
          <>
            <Button onClick={() => setMode("edit")}>Edit</Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-medium">Members</p>
          <Badge variant="secondary">{members?.length ?? "…"}</Badge>
        </div>
        {members === null ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ) : members.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul>
            {members.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0"
              >
                <p className="min-w-0 flex-1 truncate text-sm">{m.email}</p>
                <Badge variant="secondary" className="capitalize">
                  {m.role}
                </Badge>
                <button
                  className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  disabled={busy}
                  title="Remove from team"
                  onClick={() => removeMember(m)}
                >
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <select
            className="h-8 min-w-56 rounded-md border border-input bg-transparent px-2 text-sm"
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
          >
            <option value="">Add a member…</option>
            {addable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={!addUserId || busy} onClick={addMember}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete team?</AlertDialogTitle>
            <AlertDialogDescription>
              “{team!.name}” is removed for all members. Users are not deleted. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={removeTeam}
            >
              {busy ? "Deleting…" : "Delete team"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
