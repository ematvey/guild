// The skill catalog and the member's own installs, shared by the Skills
// views. Both arrive in the `skill_catalog` frame: on connect and whenever a
// skill is published, gated, unpublished, installed, uninstalled or pinned.
// Skill activity rides the `org_event` frame; the activity feed prepends the
// events it shows.

import { useEffect, useSyncExternalStore } from "react";
import type { EventRow } from "@guild/wire/rest";
import type { SkillActivityEvent, SkillInstall, SkillItem } from "./skills-api";

export interface SkillCatalog {
  items: SkillItem[];
  installs: SkillInstall[];
}

let catalog: SkillCatalog | null = null;
const listeners = new Set<() => void>();
const activityListeners = new Set<(event: SkillActivityEvent) => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): SkillCatalog | null => catalog;

function publish(next: SkillCatalog | null): void {
  catalog = next;
  for (const listener of listeners) listener();
}

/** Replaces the catalog and the member's installs (the `skill_catalog`
 *  frame). */
export function applySkillCatalog(next: SkillCatalog): void {
  publish(next);
}

/** Drops the catalog; sign-out calls this. */
export function clearSkillCatalog(): void {
  publish(null);
}

/** The catalog and installs; null until the first push. */
export function useSkillCatalog(): SkillCatalog | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True for the org events the skills activity feed lists. */
export function isSkillActivity(kind: string): boolean {
  return kind.startsWith("registry.") || kind.startsWith("skill.");
}

/** Applies one org event (the `org_event` frame): skill activity reaches the
 *  feeds on screen; other kinds have no view. */
export function applyOrgEvent(event: EventRow): void {
  if (!isSkillActivity(event.kind)) return;
  const row: SkillActivityEvent = {
    ts: event.created_at,
    kind: event.kind,
    payload:
      event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {},
  };
  for (const listener of activityListeners) listener(row);
}

/** Hears every skill activity event while mounted. The listener may change
 *  every render. */
export function useSkillActivityEvents(listener: (event: SkillActivityEvent) => void): void {
  useEffect(() => {
    activityListeners.add(listener);
    return () => {
      activityListeners.delete(listener);
    };
  });
}
