//! Stale-while-revalidate GETs for settings sections. A module-level cache
//! keeps the last successful response per path; on mount the cached value
//! renders immediately while a fresh GET updates it in the background, so
//! navigation never flashes a skeleton over known content. Skeletons appear
//! only when nothing is cached yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./admin-api";

const cache = new Map<string, unknown>();

/** Drops the module cache. Sign-out must call this: the cache otherwise
 * leaks one user's settings data into the next session on the same browser
 * profile. */
export function clearApiCache(): void {
  cache.clear();
}

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
  // Monotonic request counter: a slow response for a previous path must not
  // overwrite the new path's data (reused component instances).
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>("GET", path)
      .then((r) => {
        if (seq.current !== mine) return;
        cache.set(path, r);
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (seq.current !== mine) return;
        // Cached content stays on screen through a failed refresh.
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [path]);

  // A path change re-keys the cache (reused component instances): show the
  // new path's cached value, if any, before the fresh fetch lands. Requests
  // still in flight for the old path are invalidated by the seq bump below.
  useEffect(() => {
    seq.current++;
    setData(path ? ((cache.get(path) as T | undefined) ?? null) : null);
    setError(null);
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, reload };
}
