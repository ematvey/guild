// Skills panel (Skills tab): Catalog | Activity tabs. Catalog is the
// org skill catalog as a card grid with a search box; Activity is the
// org event feed with the All / Changes pill filter. The rail tab
// switches here; the editor surface is not wired yet, so "New skill" is
// a visible placeholder.

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@guild/ui/components/input";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { SkillDetail } from "./SkillDetail";
import { ActivityFeed } from "./ActivityFeed";
import { skillsList, type SkillItem, type SkillMe } from "./skills-api";
import { CollapseButton } from "../sidebar-contents";

/** What one catalog card renders. */
export interface SkillCard {
  slug: string;
  title: string;
  description: string;
  subtitle: string;
  meta: string;
  gated: boolean;
}

export function skillCard(item: SkillItem): SkillCard {
  const meta = `v${item.latest_version} · ${item.installs} install${item.installs === 1 ? "" : "s"}`;
  return {
    slug: item.slug,
    title: item.slug,
    description: item.description,
    subtitle: item.owner?.label ?? "",
    meta,
    gated: item.maintainer_gated,
  };
}

/** Client-side filter over slug, description and owner label
 * (case-insensitive; the server already applied its own `q` when set). */
export function filterSkills(items: SkillItem[], query: string): SkillItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter(
    (s) =>
      s.slug.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle) ||
      (s.owner?.label.toLowerCase().includes(needle) ?? false),
  );
}

/** Empty-state text, or null when cards render. */
export function skillsEmptyState(query: string, count: number): string | null {
  if (count > 0) return null;
  const needle = query.trim();
  return needle === "" ? "No skills yet." : `No skills match "${needle}".`;
}

/** The panel's two tabs: the card catalog and the activity feed. */
export type SkillsTab = "catalog" | "activity";

export function SkillsPanel({
  onCollapse,
  me,
}: {
  onCollapse?: () => void;
  me: SkillMe;
}) {
  const [tab, setTab] = useState<SkillsTab>("catalog");
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    skillsList().then((items) => {
      if (live) setSkills(items);
    });
    return () => {
      live = false;
    };
  }, [tick]);

  const filtered = filterSkills(skills ?? [], query);
  const empty = skills === null ? null : skillsEmptyState(query, filtered.length);

  if (selected !== null) {
    return (
      <SkillDetail
        slug={selected}
        me={me}
        // Back refetches the catalog: actions that change visibility
        // (unpublish) must not leave a stale card in the grid.
        onBack={() => {
          setSelected(null);
          setTick((t) => t + 1);
        }}
        onOpenSkill={setSelected}
      />
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="font-semibold">Skills</span>
        <span className="flex items-center gap-1">
          {/* Placeholder until the editor surface is wired. */}
          <Button
            variant="outline"
            size="sm"
            disabled
            aria-label="New skill (editor not available yet)"
          >
            New skill
          </Button>
          <CollapseButton onCollapse={onCollapse} />
        </span>
      </div>
      <div className="flex items-center gap-1 px-3 pb-2">
        {(
          [
            ["catalog", "Catalog"],
            ["activity", "Activity"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={tab === value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={tab === value}
            aria-label={`${label} tab`}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === "activity" && <ActivityFeed />}
      {tab === "catalog" && (
        <>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            placeholder="Search skills"
            aria-label="Search skills"
            className="pl-8"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {skills === null &&
          [0, 1, 2].map((i) => (
            <Skeleton key={i} className="mb-2 h-20 w-full rounded-md" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        {skills !== null &&
          filtered.map((item) => {
            const card = skillCard(item);
            return (
              <div
                key={card.slug}
                role="button"
                tabIndex={0}
                aria-label={`Open skill ${card.slug}`}
                className="mb-2 cursor-pointer rounded-md border border-border p-2.5 hover:bg-muted/50"
                onClick={() => setSelected(card.slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(card.slug);
                  }
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{card.title}</span>
                  {card.gated && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      gated
                    </span>
                  )}
                </div>
                {card.subtitle !== "" && (
                  <p className="truncate text-muted-foreground">{card.subtitle}</p>
                )}
                <p className="text-sm text-muted-foreground">{card.description}</p>
                <p className="pt-1 text-muted-foreground">{card.meta}</p>
              </div>
            );
          })}
        {empty !== null && <p className="px-1 py-1.5 text-muted-foreground">{empty}</p>}
      </div>
        </>
      )}
    </div>
  );
}
