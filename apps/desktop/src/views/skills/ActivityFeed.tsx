// Activity feed (Skills tab → Activity): org events as rows — icon per
// event kind, human text, timestamp — with the All / Changes to skills
// pill filter. The pill picks the server-side `filter` query; the feed
// refetches on mount and whenever the pill changes.

import { useEffect, useState } from "react";
import { useSkillActivityEvents } from "./skills-store";
import {
  Download,
  EyeOff,
  GitFork,
  Pin,
  RefreshCw,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import {
  skillsActivity,
  type SkillActivityEvent,
  type SkillActivityFilter,
} from "./skills-api";

/** Which row shape an event kind renders as; null for kinds the feed
 *  does not show. */
export type ActivityRowKind =
  | "publish"
  | "update"
  | "fork"
  | "install"
  | "pin"
  | "unpublish"
  | "uninstall";

export function activityKind(event: SkillActivityEvent): ActivityRowKind | null {
  switch (event.kind) {
    case "registry.published":
      return "publish";
    case "registry.updated":
      return "update";
    case "registry.forked":
      return "fork";
    case "skill.installed":
      return "install";
    case "skill.pinned":
      return "pin";
    case "registry.unpublished":
      return "unpublish";
    case "skill.uninstalled":
      return "uninstall";
    default:
      return null;
  }
}

export function activityIcon(event: SkillActivityEvent): LucideIcon | null {
  switch (activityKind(event)) {
    case "publish":
      return Upload;
    case "update":
      return RefreshCw;
    case "fork":
      return GitFork;
    case "install":
      return Download;
    case "pin":
      return Pin;
    case "unpublish":
      return EyeOff;
    case "uninstall":
      return EyeOff;
    default:
      return null;
  }
}

function str(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** "maya installed `sql-explorer` v2" — the actor prefix appears only
 *  when the event carries one (legacy actorless rows fall back to the
 *  actorless text). */
function sentence(actor: string | undefined, verb: string, rest: string): string {
  if (actor === undefined) return `${verb[0].toUpperCase()}${verb.slice(1)} ${rest}`;
  return `${actor} ${verb} ${rest}`;
}

/** The human row text, or null for unknown kinds. */
export function activityText(event: SkillActivityEvent): string | null {
  const kind = activityKind(event);
  if (kind === null) return null;
  const { payload } = event;
  const slug = str(payload, "slug");
  if (slug === undefined) return null;
  const version = str(payload, "version");
  switch (kind) {
    case "publish":
      return sentence(str(payload, "actor"), "published", "`" + slug + "`" + (version ? ` ${version}` : ""));
    case "update":
      return sentence(str(payload, "actor"), "updated", `\`${slug}\` to ${version ?? "a new version"}`);
    case "fork":
      return sentence(
        str(payload, "actor"),
        "forked",
        `\`${slug}\` from ${str(payload, "forked_from") ?? slug}`,
      );
    case "install":
      return sentence(str(payload, "actor"), "installed", `\`${slug}\`${version ? ` ${version}` : ""}`);
    case "pin":
      return sentence(str(payload, "actor"), "pinned", `\`${slug}\` to ${version ?? "a version"}`);
    case "uninstall":
      return sentence(str(payload, "actor"), "uninstalled", `\`${slug}\``);
    case "unpublish":
      return sentence(str(payload, "actor"), "unpublished", `\`${slug}\``);
  }
}

/** "changes" = authorship events (published/updated/forked), mirroring
 *  the server-side filter=changes kind list. */
export function activityMatchesFilter(event: SkillActivityEvent, filter: SkillActivityFilter): boolean {
  if (filter === "all") return true;
  const kind = activityKind(event);
  return kind === "publish" || kind === "update" || kind === "fork";
}

/** The ISO timestamp as a short wall clock ("2026-10-13 10:05"). */
export function activityTime(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

/** One rendered row. */
export interface ActivityRow {
  event: SkillActivityEvent;
  icon: LucideIcon;
  text: string;
  time: string;
}

/** View-model rows for a fetch result: unknown kinds dropped, filter
 *  applied, newest first (the server already sorts that way). */
export function activityRows(
  events: SkillActivityEvent[],
  filter: SkillActivityFilter,
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    if (!activityMatchesFilter(event, filter)) continue;
    const icon = activityIcon(event);
    const text = activityText(event);
    if (icon === null || text === null) continue;
    rows.push({ event, icon, text, time: activityTime(event.ts) });
  }
  return rows;
}

/** Empty-state text per filter (only shown once the fetch resolved). */
export function activityEmptyState(filter: SkillActivityFilter): string {
  return filter === "changes" ? "No changes to skills yet." : "No activity yet.";
}

export function ActivityFeed() {
  const [filter, setFilter] = useState<SkillActivityFilter>("all");
  const [events, setEvents] = useState<SkillActivityEvent[] | null>(null);
  // True once the current filter's fetch resolved — separates "still
  // loading" from "the fetch failed" (both have events === null).
  const [settled, setSettled] = useState(false);

  // Refetch on tab mount and on every pill change (mounts are the tab
  // switch path — SkillsPanel renders the feed only while it is active).
  useEffect(() => {
    let live = true;
    setSettled(false);
    skillsActivity(filter).then((result) => {
      if (live) {
        setEvents(result);
        setSettled(true);
      }
    });
    return () => {
      live = false;
    };
  }, [filter]);

  // Live: each skill org event the member socket pushes joins the top of a
  // loaded feed when it matches the pill.
  useSkillActivityEvents((event) => {
    if (!activityMatchesFilter(event, filter)) return;
    setEvents((prev) => (prev === null ? prev : [event, ...prev]));
  });

  const rows = activityRows(events ?? [], filter);
  const empty = events !== null && events.length === 0 ? activityEmptyState(filter) : null;
  // Failure note only when the fetch resolved null and there are no rows
  // to show; a failed refetch keeps the previous rows visible.
  const failed = settled && events === null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex items-center gap-1 pb-2">
        <span className="text-muted-foreground">Show:</span>
        {(
          [
            ["all", "All"],
            ["changes", "Changes to skills"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={filter === value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={filter === value}
            aria-label={`Filter activity: ${label}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {events === null &&
        [0, 1, 2].map((i) => (
          <SkeletonRows key={i} rows={1} />
        ))}
      {rows.map((row) => (
        <div key={`${row.event.kind}:${row.event.ts}:${row.event.payload.slug ?? ""}`} className="mb-1.5 flex items-start gap-2 rounded-md border border-border p-2.5">
          <row.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate">{row.text}</p>
            <p className="text-muted-foreground">{row.time}</p>
          </div>
        </div>
      ))}
      {failed && <p className="px-1 py-1.5 text-muted-foreground">Could not load activity.</p>}
      {empty !== null && <p className="px-1 py-1.5 text-muted-foreground">{empty}</p>}
      {events !== null && rows.length === 0 && empty === null && (
        <p className="px-1 py-1.5 text-muted-foreground">{activityEmptyState(filter)}</p>
      )}
    </div>
  );
}