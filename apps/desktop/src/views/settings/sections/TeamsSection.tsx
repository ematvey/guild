//! TeamsSection — admin settings, integration-style: a list screen of org
//! teams plus an "Add team" entry; the detail screen holds members
//! (add/remove) and delete.

import { useCallback, useEffect, useState } from "react";
import type { SectionDetailProps } from "../section-nav";
import { ArrowLeft, Pencil, Plus, Trash2, UsersRound, X } from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Input } from "@guild/ui/components/input";

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

const backBtn =
  "mb-4 flex items-center gap-1.5 text-base text-muted-foreground transition-colors hover:text-foreground";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export default function TeamsSection({
  detail = null,
  onDetailChange,
}: SectionDetailProps) {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ teams: TeamRow[] }>("GET", "/api/v1/admin/teams")
      .then((r) => setTeams(r.teams))
      .catch((e) => {
        setTeams([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(reload, [reload]);

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
    <div className="space-y-4">
      {error && <p className="text-base text-destructive">{error}</p>}
      <div className="flex items-center justify-between">
        <h3 className={label}>Organization teams</h3>
        <Button size="sm" onClick={() => onDetailChange("new")}>
          <Plus className="mr-1 size-3.5" /> Add team
        </Button>
      </div>
      {teams === null ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : teams.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-base text-muted-foreground">
          No teams yet — teams group users inside the organization.
        </p>
      ) : (
        <div className="space-y-2">
          {teams.map((t) => (
            <button
              key={t.id}
              className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40"
              onClick={() => onDetailChange(t.id)}
            >
              <UsersRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.member_count === 1 ? "1 member" : `${t.member_count} members`}
                </p>
              </div>
              <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </div>
      )}
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
  const [members, setMembers] = useState<UserRow[] | null>(creating ? [] : null);
  const [orgUsers, setOrgUsers] = useState<UserRow[] | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (creating) return;
    api<{ members: UserRow[] }>("GET", `/api/v1/admin/teams/${team!.id}/members`)
      .then((r) => setMembers(r.members))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api<{ users: UserRow[] }>("GET", "/api/v1/admin/users")
      .then((r) => setOrgUsers(r.users))
      .catch(() => setOrgUsers([]));
  }, [creating, team]);

  const save = async () => {
    if (busy || !name) return;
    setError(null);
    setBusy(true);
    try {
      if (creating) {
        const created = await api<{ id: string }>("POST", "/api/v1/admin/teams", { name });
        onChanged();
        onCreated(created.id);
      } else {
        await api("PUT", `/api/v1/admin/teams/${team!.id}`, { name });
        onChanged();
        setMode("view");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async () => {
    if (!addUserId || busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/api/v1/admin/teams/${team!.id}/members`, {
        user_id: addUserId,
      });
      setAddUserId("");
      const r = await api<{ members: UserRow[] }>(
        "GET",
        `/api/v1/admin/teams/${team!.id}/members`,
      );
      setMembers(r.members);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api("DELETE", `/api/v1/admin/teams/${team!.id}/members/${userId}`);
      const r = await api<{ members: UserRow[] }>(
        "GET",
        `/api/v1/admin/teams/${team!.id}/members`,
      );
      setMembers(r.members);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      onChanged();
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.id));
  const addable = (orgUsers ?? []).filter((u) => !memberIds.has(u.id));

  if (creating || mode === "edit") {
    return (
      <div>
        <button className={backBtn} onClick={onBack}>
          <ArrowLeft className="size-4" /> Teams
        </button>
        <h3 className="mb-1 text-base font-semibold">
          {creating ? "Add team" : "Edit team"}
        </h3>
        <p className="mb-4 text-xs text-muted-foreground">
          {creating
            ? "Name the team; members are managed after creation."
            : "Rename the team; members are managed on the team page."}
        </p>
        <div className="max-w-xl space-y-4">
          <div>
            <p className={label}>Team name</p>
            <Input
              className="mt-1.5"
              placeholder="e.g. platform"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </div>
          {error && <p className="text-base text-destructive">{error}</p>}
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
    <div>
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Teams
      </button>
      <h3 className="mb-1 text-base font-semibold">{team?.name || "…"}</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Members of this team. Adding or removing takes effect immediately.
      </p>

      <div className="max-w-xl space-y-4">
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <p className={label}>Members</p>
          </div>
          {members === null ? (
            <div className="space-y-2 p-4">
              <div className="h-8 w-full animate-pulse rounded-md bg-accent" />
            </div>
          ) : members.length === 0 ? (
            <p className="p-4 text-base text-muted-foreground">No members yet.</p>
          ) : (
            <ul>
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-b-0"
                >
                  <p className="min-w-0 flex-1 truncate text-base">{m.email}</p>
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
                    {m.role}
                  </span>
                  <button
                    className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                    disabled={busy}
                    title="Remove from team"
                    onClick={() => removeMember(m.id)}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            className="h-9 min-w-56 rounded-md border border-input bg-card px-2 text-base"
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
            <Plus className="mr-1 size-3.5" /> Add
          </Button>
        </div>

        {error && <p className="text-base text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button onClick={() => setMode("edit")}>
            <Pencil className="mr-1 size-3.5" /> Edit
          </Button>
          {confirmDelete ? (
            <>
              <Button variant="destructive" disabled={busy} onClick={removeTeam}>
                Delete team
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
              <Trash2 className="mr-1 size-3.5" /> Delete team
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
