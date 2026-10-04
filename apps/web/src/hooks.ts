import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, api, type Card, type LiveMarket } from "./api";
import { cachedGet, peek } from "./cache";

export interface Loadable<T> {
  data: T | null;
  /**
   * `data` answers an earlier path or key (the previous page, the window before the switch, the
   * feed before a settings change) and is shown only until the new answer lands.
   */
  stale: boolean;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** A cached response younger than this is shown without refetching when a view mounts. */
const FRESH_ON_MOUNT_MS = 10_000;

/** After failures the poll stretches to `intervalMs` doubled per failure, up to this. */
const MAX_BACKOFF_MS = 300_000;

/**
 * GETs `path` on mount and whenever `path` or `key` changes, then every `intervalMs` while the tab
 * is visible. Bump `key` to force a refetch of the same path (e.g. after the user changes a
 * setting the response depends on).
 *
 * Starts from the shared cache (src/cache.ts), so a view that was open before, or whose request
 * main.tsx started at boot, paints at once. Keeps showing the last good data while a refetch is in
 * flight or fails. When `path` or `key` changes and the cache has nothing for it, the previous
 * answer stays up, flagged `stale`, until the new one lands, so the view dims rather than blanking
 * to a skeleton and collapsing. Reloads that arrive while a request is in flight (SSE nudges in a burst) are
 * coalesced into one follow-up request. While requests keep failing (API or database down), the
 * timed poll backs off so every open tab doesn't keep hitting it at full rate.
 */
export function usePolling<T>(path: string, intervalMs: number, key = ""): Loadable<T> {
  const want = `${path}\n${key}`;
  // The data and the path+key it answers.
  // An answer restored from an earlier visit shows as stale until this visit's own lands.
  const [held, setHeld] = useState<{ data: T; for: string } | null>(() => {
    const cached = peek<T>(path);
    return cached ? { data: cached.data, for: cached.restored ? "" : want } : null;
  });
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;
  const wantRef = useRef(want);
  wantRef.current = want;
  const seq = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const failures = useRef(0);
  /** The timed poll skips ticks before this (ms), set while failing. */
  const retryAt = useRef(0);

  const run = useCallback((maxAgeMs: number) => {
    const mine = ++seq.current;
    busy.current = true;
    setLoading(true);
    cachedGet<T>(pathRef.current, maxAgeMs)
      .then((d) => {
        if (mine !== seq.current) return;
        failures.current = 0;
        retryAt.current = 0;
        setHeld({ data: d, for: wantRef.current });
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        const every = intervalRef.current;
        const backoff = Math.max(every, Math.min(MAX_BACKOFF_MS, every * 2 ** failures.current++));
        retryAt.current = Date.now() + backoff - every;
        // An older path's data must not stand in for this one's error.
        setHeld((h) => (h && h.for !== wantRef.current ? null : h));
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
    // A key bump means "the answer changed": skip the cache. Otherwise a fresh cached answer (or
    // the boot prefetch still in flight) is reused.
    const forced = key !== firstKey.current;
    firstKey.current = key;
    // A new path shows its own cached data if any; otherwise the previous answer stays up as stale.
    const cached = forced ? null : peek<T>(path);
    if (cached) setHeld({ data: cached.data, for: cached.restored ? "" : `${path}\n${key}` });
    setError(null);
    again.current = false;
    run(forced ? -1 : FRESH_ON_MOUNT_MS);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() >= retryAt.current) reload();
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

  const data = held?.data ?? null;
  return { data, stale: held !== null && held.for !== want, error, loading, reload };
}

/** First wait before reopening a dropped nudge stream; doubles per failure up to the cap. */
const STREAM_RETRY_MS = 5_000;
const STREAM_RETRY_MAX_MS = 300_000;

interface StreamSubscriber {
  onEvent: () => void;
  onLive: (live: boolean) => void;
  keepWhenHidden: boolean;
}

/**
 * One EventSource per stream path for the whole page, shared by every view that wants it (the Live
 * tab and the alert notifier both listen to the same two streams), so the page never holds two
 * connections for one stream.
 */
class SharedStream {
  private readonly subs = new Set<StreamSubscriber>();
  private source: EventSource | null = null;
  private retry: number | undefined;
  private failures = 0;
  private live = false;

  constructor(private readonly path: string) {}

  add(sub: StreamSubscriber): () => void {
    this.subs.add(sub);
    sub.onLive(this.live);
    this.sync();
    return () => {
      this.subs.delete(sub);
      this.sync();
    };
  }

  /** Opens or closes to match who is listening and whether the browser tab is visible. */
  sync(): void {
    const visible = document.visibilityState === "visible";
    const wanted = [...this.subs].some((s) => visible || s.keepWhenHidden);
    if (!wanted) this.close();
    else if (!this.source && this.retry === undefined) this.open();
  }

  private setLive(live: boolean) {
    this.live = live;
    for (const s of this.subs) s.onLive(live);
  }

  private close() {
    window.clearTimeout(this.retry);
    this.retry = undefined;
    this.source?.close();
    this.source = null;
    this.setLive(false);
  }

  private open() {
    this.close();
    const es = new EventSource(`${API_URL}${this.path}`, { withCredentials: true });
    this.source = es;
    const fire = () => {
      for (const s of [...this.subs]) s.onEvent();
    };
    es.addEventListener("ready", () => {
      this.failures = 0;
      this.setLive(true);
    });
    es.onmessage = fire;
    es.addEventListener("match", fire);
    es.addEventListener("curated", fire);
    es.onerror = () => {
      this.close();
      const wait = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** this.failures++);
      this.retry = window.setTimeout(
        () => {
          this.retry = undefined;
          this.sync();
        },
        wait / 2 + Math.random() * (wait / 2),
      );
    };
  }
}

const sharedStreams = new Map<string, SharedStream>();
let visibilityHooked = false;

function sharedStream(path: string): SharedStream {
  let stream = sharedStreams.get(path);
  if (!stream) {
    stream = new SharedStream(path);
    sharedStreams.set(path, stream);
  }
  if (!visibilityHooked) {
    visibilityHooked = true;
    document.addEventListener("visibilitychange", () => {
      for (const s of sharedStreams.values()) s.sync();
    });
  }
  return stream;
}

/**
 * Subscribes to one of the API's SSE nudge streams (/curated/stream, /matches/stream) and calls
 * `onEvent` on each message. The stream only says "something new" - the caller refetches. The
 * caller's polling stays on as the fallback, so a dropped stream only costs latency.
 *
 * The stream is closed while the browser tab is hidden (a hidden tab would refetch on every nudge
 * and hold a server connection for nothing; polling's catch-up on return covers the gap) unless a
 * subscriber passes `keepWhenHidden` - the alert notifier does, so a background tab still pings.
 * A dropped stream is reopened here with backoff and jitter, instead of the browser's own
 * fixed-interval retry - which also gives up for good on any non-200, such as a 502 while the API
 * restarts.
 */
export function useNudgeStream(
  path: string,
  onEvent: () => void,
  enabled = true,
  keepWhenHidden = false,
): boolean {
  const [live, setLive] = useState(false);
  const callback = useRef(onEvent);
  callback.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const remove = sharedStream(path).add({
      onEvent: () => callback.current(),
      onLive: setLive,
      keepWhenHidden,
    });
    return () => {
      remove();
      setLive(false);
    };
  }, [path, enabled, keepWhenHidden]);

  return live;
}

/** How often an open feed asks for fresh market caps. The API keeps each reading under 8s old. */
const LIVE_TICK_MS = 10_000;

/**
 * Keeps the "Now" market cap on `cards` seconds old: polls GET /live/market for the tokens on
 * screen every LIVE_TICK_MS while the tab is visible (and at once when they change or the tab
 * comes back), and returns the cards with any newer reading laid over them. The full feed poll is
 * much slower and stays the source of everything else on a card.
 *
 * A failed tick just leaves the last numbers up; the next one tries again.
 */
export function useLiveMarketCaps(cards: Card[] | undefined): Card[] | undefined {
  const [live, setLive] = useState<Map<string, { marketCapUsd: number; at: string }>>(() => new Map());
  const ids = cards ? [...new Set(cards.map((c) => c.tokenId))].sort().join(",") : "";

  useEffect(() => {
    if (!ids) return;
    let stopped = false;
    let busy = false;
    const tick = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api<LiveMarket>(`/live/market?tokens=${encodeURIComponent(ids)}`)
        .then((res) => {
          if (stopped) return;
          setLive((prev) => {
            const next = new Map(prev);
            for (const t of res.tokens) next.set(t.id, { marketCapUsd: t.marketCapUsd, at: t.at });
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, LIVE_TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ids]);

  return useMemo(() => {
    if (!cards || live.size === 0) return cards;
    return cards.map((card) => {
      const reading = live.get(card.tokenId);
      if (!reading) return card;
      // The feed may already carry something newer (a scan snapshot, or a later poll).
      const cardAt = card.currentMarketCapAt ? new Date(card.currentMarketCapAt).getTime() : 0;
      if (new Date(reading.at).getTime() <= cardAt) return card;
      return { ...card, currentMarketCapUsd: reading.marketCapUsd, currentMarketCapAt: reading.at };
    });
  }, [cards, live]);
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
