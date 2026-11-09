// The Apps page's URL contract:
//   /apps        — the list, nothing open
//   /apps/<id>   — one App open beside the list (alone on a phone)

export interface AppsRoute {
  appId: string | null;
}

export const APPS_HOME: AppsRoute = { appId: null };

/** Parses the segments after /apps. */
export function parseAppsRoute(parts: string[]): AppsRoute {
  const id = parts[0];
  return { appId: id !== undefined && id !== "" ? id : null };
}

/** The address of a route; the inverse of parseAppsRoute. */
export function appsRoutePath(route: AppsRoute): string {
  return route.appId === null ? "/apps" : `/apps/${encodeURIComponent(route.appId)}`;
}
