import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "./api";
import { cachedGet, peek } from "./cache";

export interface Loadable<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** A cached response younger than this is shown without refetching when a view mounts. */
const FRESH_ON_MOUNT_MS = 10_000;

/**
 * GETs `path` on mount and whenever `path` or `key` changes, then every `intervalMs` while the tab
 * is visible. Bump `key` to force a refetch of the same path (e.g. after the user changes a
 * setting the response depends on).
 *
 * Starts from the shared cache (src/cache.ts), so a view that was open before, or whose request
 * main.tsx started at boot, paints at once. Keeps showing the last good data while a refetch is in
 * flight or fails. Reloads that arrive while a request is in flight (SSE nudges in a burst) are
 * coalesced into one follow-up request.
 */
export function usePolling<T>(path: string, intervalMs: number, key = ""): Loadable<T> {
  const [data, setData] = useState<T | null>(() => peek<T>(path)?.data ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;
  const seq = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);

  const run = useCallback((maxAgeMs: number) => {
    const mine = ++seq.current;
    busy.current = true;
    setLoading(true);
    cachedGet<T>(pathRef.current, maxAgeMs)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (mine !== seq.current) return;
        busy.current = false;
        if (again.current) {
          again.current = false;
          run(-1);
        } else setLoading(false);
      });
  }, []);

  const reload = useCallback(() => {
    if (busy.current) again.current = true;
    else run(-1);
  }, [run]);

  const firstKey = useRef(key);
  useEffect(() => {
    // A new path shows its own cached data (or nothing), never the previous path's.
    setData(peek<T>(path)?.data ?? null);
    setError(null);
    again.current = false;
    // A key bump means "the answer changed": skip the cache. Otherwise a fresh cached answer (or
    // the boot prefetch still in flight) is reused.
    const forced = key !== firstKey.current;
    firstKey.current = key;
    run(forced ? -1 : FRESH_ON_MOUNT_MS);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    // Coming back to the tab refreshes only what has gone stale while it was hidden.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const cached = peek<T>(pathRef.current);
      if (!cached || Date.now() - cached.at >= Math.min(intervalMs, 60_000)) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // Results for this effect's path that land after cleanup must not overwrite the next one.
      seq.current++;
      busy.current = false;
    };
  }, [path, key, intervalMs, run, reload]);

  return { data, error, loading, reload };
}

/**
 * Subscribes to one of the API's SSE nudge streams (/curated/stream, /matches/stream) and calls
 * `onEvent` on each message. The stream only says "something new" - the caller refetches. The
 * caller's polling stays on as the fallback, so a dropped stream only costs latency.
 */
export function useNudgeStream(path: string, onEvent: () => void, enabled = true): boolean {
  const [live, setLive] = useState(false);
  const callback = useRef(onEvent);
  callback.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource(`${API_URL}${path}`, { withCredentials: true });
    source.addEventListener("ready", () => setLive(true));
    source.onmessage = () => callback.current();
    source.addEventListener("match", () => callback.current());
    source.addEventListener("curated", () => callback.current());
    source.onerror = () => setLive(false);
    return () => {
      source.close();
      setLive(false);
    };
  }, [path, enabled]);

  return live;
}

/** Re-renders every `ms` - for countdowns and "3m ago" labels. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
