//! TeamsSection — org teams as a data table; the detail page shows the team
//! with a members table, add-member row, rename and delete actions.

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { entityDetailCodec } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  removeTeamMember,
  SETTINGS_PATHS,
  teamMembersPath,
  updateTeam,
} from "../../../lib/api/settings";
import { Plus, Trash2, UsersRound, X } from "lucide-react";
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
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows, SkeletonForm } from "@guild/ui/components/skeleton";
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
  const teamsRes = useCachedGet<{ teams: TeamRow[] }>(SETTINGS_PATHS.teams);
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

  const view = entityDetailCodec.parse(detail);
  const open = (next: Parameters<typeof entityDetailCodec.format>[0]) =>
    onDetailChange(entityDetailCodec.format(next));

  if (view.kind !== "list") {
    // Deep-linked team page: wait for the list before resolving the id —
    // a not-yet-loaded row would render as the add-team form.
    if (view.kind === "row" && teams === null) {
      if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
      return <SkeletonForm />;
    }
    const team = view.kind === "new" ? null : teams?.find((t) => t.id === view.id) ?? null;
    if (view.kind === "row" && !team) return <EmptyState title="Team not found" hint="It may have been deleted." icon={UsersRound} />;
    return (
      <TeamDetail
        team={team}
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
        title="Teams"
        description="Teams group users inside the organization."
        actions={
          <Button size="sm" onClick={() => open({ kind: "new" })}>
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
        onRowClick={(t) => open({ kind: "row", id: t.id })}
        empty={
          <EmptyState
            icon={UsersRound}
            title="No teams yet"
            hint="Create a team to group users for model routes and approvals."
            action={
              <Button size="sm" onClick={() => open({ kind: "new" })}>
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
    creating ? null : teamMembersPath(team!.id),
  );
  const members = creating ? [] : (membersRes.data?.members ?? null);
  const orgUsers = useCachedGet<{ users: UserRow[] }>(SETTINGS_PATHS.users).data?.users ?? null;

  const save = async () => {
    if (busy || !name) return;
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        const created = await createTeam<{ id: string }>({ name });
        toast.success("Team created", { description: name });
        onChanged();
        onCreated(created.id);
      } else {
        await updateTeam(team!.id, { name });
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
      await addTeamMember(team!.id, {
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
      await removeTeamMember(team!.id, user.id);
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
      await deleteTeam(team!.id);
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
            <SkeletonRows rows={1} />
            <SkeletonRows rows={1} />
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
