// The workspace's identity as the member socket pushes it: the name and
// logo, the admin's telemetry switch, and the web bundle the server serves.
// Every view that shows one of them reads this store; none fetches it.

import { useSyncExternalStore } from "react";
import type { ServerFrame } from "@guild/wire/types";

export type WorkspaceIdentity = Omit<Extract<ServerFrame, { type: "workspace_identity" }>, "type">;

let snapshot: WorkspaceIdentity | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WorkspaceIdentity | null {
  return snapshot;
}

/** The pushed identity, or null until the first `workspace_identity`
 *  frame. */
export function useWorkspaceIdentity(): WorkspaceIdentity | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Replaces the identity (the `workspace_identity` frame). */
export function applyWorkspaceIdentity(identity: WorkspaceIdentity): void {
  snapshot = identity;
  for (const listener of listeners) listener();
}

/** The identity of the bundle this page runs: the hash in its entry
 *  script's name (`/assets/index-<hash>.js`). null when the page was not
 *  loaded from a built bundle (the dev server). */
export function runningWebBundle(doc: Pick<Document, "querySelector"> | undefined =
  typeof document === "undefined" ? undefined : document): string | null {
  const src = doc?.querySelector('script[src*="/assets/index-"]')?.getAttribute("src");
  return src?.match(/index-([^"'/]+)\.js/)?.[1] ?? null;
}

/** True when the server serves a different bundle than the running one.
 *  Unknown on either side is never outdated. */
export function webBundleOutdated(served: string | undefined, running: string | null): boolean {
  return served !== undefined && running !== null && served !== running;
}

/** Drops the identity; sign-out clears it so the next workspace starts
 *  empty. */
export function clearWorkspaceIdentity(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}
