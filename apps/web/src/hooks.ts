import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "./api";

export interface Loadable<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches on mount and whenever `key` changes, then every `intervalMs` while the tab is visible.
 * Keeps showing the last good data while a refetch is in flight or fails.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, key = ""): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    loadRef
      .current()
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
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setData(null);
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, intervalMs, key]);

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
