//! Stale-while-revalidate GETs for settings sections. A module-level cache
//! keeps the last successful response per path; on mount the cached value
//! renders immediately while a fresh GET updates it in the background, so
//! navigation never flashes a skeleton over known content. Skeletons appear
//! only when nothing is cached yet. Every mounted reader of one path shows
//! the same value: a fresh response or a local write reaches all of them.

import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "../../lib/api/request";
import { registerSessionReset } from "../../lib/session-reset";

const cache = new Map<string, unknown>();
/** Mounted readers per path. */
const readers = new Map<string, Set<(value: unknown) => void>>();

/** Stores a value for a path and hands it to every mounted reader. */
function publish(path: string, value: unknown): void {
  cache.set(path, value);
  for (const reader of readers.get(path) ?? []) reader(value);
}

/** Replaces the cached value of a path from the one held now (a section's
 *  own successful write), and every mounted reader of it repaints. A path
 *  with nothing cached stays empty. */
export function updateCached<T>(path: string, update: (value: T) => T): void {
  if (!cache.has(path)) return;
  publish(path, update(cache.get(path) as T));
}

/** Section caches that clear with the settings cache (sign-out). */

// Session generation for every module cache: each clear bumps it, and async
// writers verify the generation they started under — a response landing
// after a sign-out clear belongs to the signed-out account and must not
// repopulate the cache for the next one.
let cacheEpoch = 0;

/** The generation in-flight requests should capture at start. */
export function currentCacheEpoch(): number {
  return cacheEpoch;
}

/** True when a request started under `epoch` is stale (a clear happened
 * since) and its response must be dropped. */
export function cacheEpochChanged(epoch: number): boolean {
  return epoch !== cacheEpoch;
}

/** Drops the module cache and invalidates in-flight writers. Sign-out runs
 *  it through the session reset: the cache otherwise leaks one user's
 *  settings data into the next session on the same browser profile. */
export function clearSettingsCaches(): void {
  cacheEpoch++;
  cache.clear();
}
registerSessionReset(clearSettingsCaches);

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
  /** True once a fetch for this path completed on this mount (success or
   * failure). A cached-but-stale value does not set it — detail pages use it
   * to tell "not found" apart from "the fresh list is still loading". */
  settled: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(() =>
    path ? ((cache.get(path) as T | undefined) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  // Monotonic request counter: a slow response for a previous path must not
  // overwrite the new path's data (reused component instances).
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    const epoch = currentCacheEpoch();
    setSettled(false);
    request<T>("GET", path)
      .then((r) => {
        if (seq.current !== mine || cacheEpochChanged(epoch)) return;
        publish(path, r);
        setError(null);
        setSettled(true);
      })
      .catch((e) => {
        if (seq.current !== mine || cacheEpochChanged(epoch)) return;
        // Cached content stays on screen through a failed refresh.
        setError(e instanceof Error ? e.message : String(e));
        setSettled(true);
      });
  }, [path]);

  // A path change re-keys the cache (reused component instances): show the
  // new path's cached value, if any, before the fresh fetch lands. Requests
  // still in flight for the old path are invalidated by the seq bump below.
  useEffect(() => {
    seq.current++;
    setData(path ? ((cache.get(path) as T | undefined) ?? null) : null);
    setError(null);
    setSettled(false);
  }, [path]);

  useEffect(() => {
    if (!path) return;
    const reader = (value: unknown) => setData(value as T);
    let set = readers.get(path);
    if (set === undefined) {
      set = new Set();
      readers.set(path, set);
    }
    set.add(reader);
    return () => {
      set.delete(reader);
      if (set.size === 0) readers.delete(path);
    };
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, settled, reload };
}
