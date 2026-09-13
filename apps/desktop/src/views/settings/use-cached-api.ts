//! Stale-while-revalidate GETs for settings sections. A module-level cache
//! keeps the last successful response per path; on mount the cached value
//! renders immediately while a fresh GET updates it in the background, so
//! navigation never flashes a skeleton over known content. Skeletons appear
//! only when nothing is cached yet.

import { useCallback, useEffect, useState } from "react";
import { api } from "./admin-api";

const cache = new Map<string, unknown>();

/** Last successful response for a GET path, if one is cached. Lets a section
 * initialize non-fetch state (like edit modes) from data before the first
 * render. */
export function peekCached<T>(path: string): T | undefined {
  return cache.get(path) as T | undefined;
}

/** Buckets a timestamp to `ms` granularity, so query paths carrying from/to
 * dates repeat across navigations within the window instead of producing a
 * new cache key every mount. */
export function quantizeIso(ms: number, now = Date.now()): string {
  return new Date(Math.floor(now / ms) * ms).toISOString();
}

export function useCachedGet<T>(path: string | null): {
  data: T | null;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(() =>
    path ? ((cache.get(path) as T | undefined) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!path) return;
    api<T>("GET", path)
      .then((r) => {
        cache.set(path, r);
        setData(r);
        setError(null);
      })
      .catch((e) => {
        // Cached content stays on screen through a failed refresh.
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [path]);

  // A path change re-keys the cache (reused component instances): show the
  // new path's cached value, if any, before the fresh fetch lands.
  useEffect(() => {
    setData(path ? ((cache.get(path) as T | undefined) ?? null) : null);
    setError(null);
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, reload };
}
