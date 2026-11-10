// The access panel: one item's list of who may reach it and how. Agents and
// Apps use this one element; `kind` names the item's route and `id` the item.
// The org entry is read-only, because sharing with everyone never hands out
// management.

import { useEffect, useState } from "react";
import { Globe, Loader2, Trash2, User, Users } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import type { AccessEntry, AccessLevel, AccessPerson } from "@guild/wire/rest";
import { listMyTeams, type TeamOption } from "../agents/agents-api";
import {
  getAccess,
  listAccessPeople,
  putAccess,
  type AccessKind,
} from "./access-api";

const KIND_NOUN: Record<AccessKind, string> = { agent: "agent", app: "app" };

function Icon({ entry }: { entry: AccessEntry }) {
  if (entry.subject_kind === "org")
    return <Globe className="size-4 text-muted-foreground" />;
  if (entry.subject_kind === "team")
    return <Users className="size-4 text-muted-foreground" />;
  return <User className="size-4 text-muted-foreground" />;
}

/** One row of the list: who, at which level, and the way out. */
function EntryRow({
  entry,
  disabled,
  onLevel,
  onRemove,
}: {
  entry: AccessEntry;
  disabled: boolean;
  onLevel: (level: AccessLevel) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
      <Icon entry={entry} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {entry.subject_label}
      </span>
      {entry.subject_kind === "org" ? (
        <span className="text-xs text-muted-foreground">can read</span>
      ) : (
        <Select
          value={entry.level}
          onValueChange={(value) => onLevel(value as AccessLevel)}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">Can read</SelectItem>
            <SelectItem value="edit">Can edit</SelectItem>
          </SelectContent>
        </Select>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove ${entry.subject_label}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}

export function AccessPanel({
  kind,
  id,
  disabled = false,
}: {
  kind: AccessKind;
  id: string;
  disabled?: boolean;
}) {
  const [entries, setEntries] = useState<AccessEntry[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [people, setPeople] = useState<AccessPerson[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    setEntries(null);
    setError(null);
    getAccess(kind, id)
      .then((list) => {
        if (dead) return;
        setEntries(list.entries);
        setCanEdit(list.can_edit);
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    void listAccessPeople()
      .then((rows) => {
        if (!dead) setPeople(rows);
      })
      .catch(() => setPeople([]));
    void listMyTeams()
      .then((rows) => {
        if (!dead) setTeams(rows);
      })
      .catch(() => setTeams([]));
    return () => {
      dead = true;
    };
  }, [kind, id]);

  const editable = canEdit && !disabled;

  /** Writes the whole list: the server replaces what it had. */
  const save = async (next: AccessEntry[]) => {
    const before = entries;
    setEntries(next);
    setBusy(true);
    setError(null);
    try {
      const list = await putAccess(kind, id, next);
      setEntries(list.entries);
    } catch (e) {
      setEntries(before);
      setError(
        e instanceof Error ? e.message : "Could not save the access list.",
      );
    } finally {
      setBusy(false);
    }
  };

  const addOrg = () =>
    void save([
      ...(entries ?? []),
      {
        subject_kind: "org",
        subject_id: null,
        subject_label: "Everyone in the org",
        level: "read",
      },
    ]);
  const addTeam = (teamId: string) => {
    const team = teams.find((row) => row.id === teamId);
    if (team === undefined) return;
    void save([
      ...(entries ?? []),
      {
        subject_kind: "team",
        subject_id: team.id,
        subject_label: team.name,
        level: "read",
      },
    ]);
  };
  const addPerson = (personId: string) => {
    const person = people.find((row) => row.id === personId);
    if (person === undefined) return;
    void save([
      ...(entries ?? []),
      {
        subject_kind: "user",
        subject_id: person.id,
        subject_label: person.label,
        level: "read",
      },
    ]);
  };
  const setLevel = (target: AccessEntry, level: AccessLevel) =>
    void save(
      (entries ?? []).map((entry) =>
        entry === target ? { ...entry, level } : entry,
      ),
    );
  const remove = (target: AccessEntry) =>
    void save((entries ?? []).filter((entry) => entry !== target));

  const hasOrg = (entries ?? []).some((entry) => entry.subject_kind === "org");
  const named = new Set((entries ?? []).map((entry) => entry.subject_id));
  const teamChoices = teams.filter((team) => !named.has(team.id));
  const peopleChoices = people.filter((person) => !named.has(person.id));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Everyone listed can open this {KIND_NOUN[kind]}. Can edit also lets
          them change it.
        </p>
        {busy && (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
      {entries === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground">
          Only you can open this {KIND_NOUN[kind]}.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <EntryRow
              key={`${entry.subject_kind}:${entry.subject_id ?? ""}`}
              entry={entry}
              disabled={!editable || busy}
              onLevel={(level) => setLevel(entry, level)}
              onRemove={() => remove(entry)}
            />
          ))}
        </ul>
      )}
      {editable && entries !== null && (
        <div className="flex flex-wrap items-center gap-1.5">
          {!hasOrg && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addOrg}
              disabled={busy}
            >
              <Globe /> Everyone in the org
            </Button>
          )}
          {teamChoices.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                >
                  <Users /> Add a team
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-72 overflow-y-auto"
              >
                {teamChoices.map((team) => (
                  <DropdownMenuItem
                    key={team.id}
                    onSelect={() => addTeam(team.id)}
                  >
                    {team.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {peopleChoices.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                >
                  <User /> Add a person
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-72 overflow-y-auto"
              >
                {peopleChoices.map((person) => (
                  <DropdownMenuItem
                    key={person.id}
                    onSelect={() => addPerson(person.id)}
                  >
                    {person.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
