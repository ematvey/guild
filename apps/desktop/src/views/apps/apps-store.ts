// The Apps the member sees, as the `app_list` frame carries them: on connect
// and whenever an App of the org is published, shared, unshared or deleted.

import { createStore } from "../../lib/store";
import type { App } from "@guild/wire/rest";

const apps = createStore<App[] | null>(null);

/** Replaces the list (the `app_list` frame). */
export function applyAppList(next: App[]): void {
  apps.set(next);
}

/** The Apps; null until the first push. */
export function useApps(): App[] | null {
  return apps.use();
}
