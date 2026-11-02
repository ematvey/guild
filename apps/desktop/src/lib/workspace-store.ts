// The workspace's identity as the member socket pushes it: the name and
// logo, the admin's telemetry switch, and the web bundle the server serves.
// Every view that shows one of them reads this store; none fetches it.

import type { ServerFrame } from "@guild/wire/types";
import { createStore } from "./store";

export type WorkspaceIdentity = Omit<Extract<ServerFrame, { type: "workspace_identity" }>, "type">;

const identity = createStore<WorkspaceIdentity | null>(null);

/** The pushed identity, or null until the first `workspace_identity`
 *  frame. */
export function useWorkspaceIdentity(): WorkspaceIdentity | null {
  return identity.use();
}

/** Replaces the identity (the `workspace_identity` frame). */
export function applyWorkspaceIdentity(next: WorkspaceIdentity): void {
  identity.set(next);
}

/** The identity of the bundle this page runs: the hash in its entry
 *  script's name (`/assets/index-<hash>.js`). null when the page was not
 *  loaded from a built bundle (the dev server). */
export function runningWebBundle(
  doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document,
): string | null {
  const src = doc?.querySelector('script[src*="/assets/index-"]')?.getAttribute("src");
  return src?.match(/index-([^"'/]+)\.js/)?.[1] ?? null;
}

/** True when the server serves a different bundle than the running one.
 *  Unknown on either side is never outdated. */
export function webBundleOutdated(served: string | undefined, running: string | null): boolean {
  return served !== undefined && running !== null && served !== running;
}

/** Drops the identity (sign-out resets it with every other store). */
export const clearWorkspaceIdentity = identity.reset;
