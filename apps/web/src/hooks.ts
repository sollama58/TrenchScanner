import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_URL, api, type Card, type LiveMarket } from "./api";
import { cachedGet, peek } from "./cache";
import { chartHistoryExtended, isChartPollPath, type ChartPollBody } from "./chartPoll";
import { beginWait } from "./loadTracker";
import { READING_LAG_MS } from "./marketClock";
import { sessionToken } from "./session";

export interface Loadable<T> {
  data: T | null;
  /**
   * `data` answers an earlier path or key (the previous page, the window before the switch, the
   * feed before a settings change) and is shown only until the new answer lands.
   */
  stale: boolean;
  /** When `data` arrived (ms), from this visit or an earlier one; null with no data. */
  at: number | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  /**
   * The timed poll's beat: its first tick (`from`, ms) and every `every` ms after, for a
   * "Next update in" that counts to the read that actually comes. Null before it starts.
   */
  schedule?: { from: number; every: number } | null;
}

/** A cached response younger than this is shown without refetching when a view mounts. */
const FRESH_ON_MOUNT_MS = 10_000;

/** How far past the browser cache a mount read goes. Chart paths always refetch: a fresh tail can hide older candles. */
export function pollMountMaxAge(path: string, forced: boolean): number {
  if (forced) return -1;
  if (isChartPollPath(path)) return 0;
  return FRESH_ON_MOUNT_MS;
}

/** Whether a tab coming back should poll this path (chart always; others when the cache has aged). */
export function shouldPollOnVisible(path: string, cachedAt: number | null, intervalMs: number): boolean {
  if (isChartPollPath(path)) return true;
  if (cachedAt === null) return true;
  return Date.now() - cachedAt >= Math.min(intervalMs, 60_000);
}

/** The path and key a poll answer belongs to. */
export function pollWant(path: string, key: string): string {
  return `${path}\n${key}`;
}

export interface PollHeld<T> {
  data: T;
  /** `pollWant` of the path and key this payload was read for. */
  for: string;
  saved: boolean;
  at: number;
}

/**
 * Fold one finished read into what is on screen. `want` is the path and key showing now;
 * `result.for` is the path and key that were actually read. A read for anything else is left
 * untouched, so a slow response for the previous coin cannot be stored as this coin's.
 * An error for the coin now showing drops a held answer that belonged to another coin.
 */
export function applyPollResult<T>(
  held: PollHeld<T> | null,
  want: string,
  result: { for: string; data?: T; at?: number; error?: boolean },
): PollHeld<T> | null {
  if (result.for !== want) return held;
  if (result.error) return held && held.for !== want ? null : held;
  return { data: result.data as T, for: result.for, saved: false, at: result.at ?? 0 };
}

/** True when `held` is not an answer for `want` (another path or key, or a copy from an earlier visit). */
export function pollIsStale(held: { for: string; saved: boolean } | null, want: string): boolean {
  return held !== null && (held.for !== want || held.saved);
}

/**
 * A lookup's body, shown only for the mint now open. A stale read (the previous coin, still on
 * screen until this one lands) or a payload for another mint is dropped.
 */
export function viewForMint<T extends { mint: string }>(
  mint: string,
  data: T | null,
  stale: boolean,
): T | null {
  return data && !stale && data.mint === mint ? data : null;
}

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
 * to a skeleton and collapsing. A response is stored under the path it was read for, never the
 * path current when it arrives, so a slow read of the previous coin cannot clear that flag.
 * Reloads that arrive while a request is in flight (SSE nudges in a burst) are
 * coalesced into one follow-up request. While requests keep failing (API or database down), the
 * timed poll backs off so every open tab doesn't keep hitting it at full rate.
 */
export function usePolling<T>(path: string, intervalMs: number, key = ""): Loadable<T> {
  const want = pollWant(path, key);
  // The data and the path+key it answers. An answer restored from an earlier visit (`saved`)
  // shows as stale until this visit's own lands, but stays up if the API can't be reached.
  const [held, setHeld] = useState<PollHeld<T> | null>(() => {
    const cached = peek<T>(path);
    return cached ? { data: cached.data, for: want, saved: cached.restored, at: cached.at } : null;
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
  const [schedule, setSchedule] = useState<{ from: number; every: number } | null>(null);
  /** The timed poll skips ticks before this (ms), set while failing. */
  const retryAt = useRef(0);

  const run = useCallback((maxAgeMs: number) => {
    const mine = ++seq.current;
    // Captured now. The refs move as soon as the next coin renders, which is before this
    // request's effect cleans up, so a resolution must be filed under the path it asked for.
    const requestedPath = pathRef.current;
    const requested = wantRef.current;
    busy.current = true;
    setLoading(true);
    cachedGet<T>(requestedPath, maxAgeMs)
      .then((d) => {
        if (mine !== seq.current) return;
        const at = peek<T>(requestedPath)?.at ?? Date.now();
        setHeld((h) => applyPollResult(h, wantRef.current, { for: requested, data: d, at }));
        // A response for a coin the reader has already left must not clear this coin's error
        // or its backoff. The payload itself was ignored above.
        if (requested !== wantRef.current) return;
        failures.current = 0;
        retryAt.current = 0;
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current || requested !== wantRef.current) return;
        const every = intervalRef.current;
        const backoff = Math.max(every, Math.min(MAX_BACKOFF_MS, every * 2 ** failures.current++));
        retryAt.current = Date.now() + backoff - every;
        // An older path's data must not stand in for this one's error.
        setHeld((h) => applyPollResult(h, wantRef.current, { for: requested, error: true }));
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (mine !== seq.current || requested !== wantRef.current) return;
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
  // The timed poll: a new request unless one is in flight, which the browser's HTTP cache may
  // answer (reload() is for "something changed", and goes past it).
  const poll = useCallback(() => {
    if (!busy.current) run(0);
  }, [run]);

  const firstKey = useRef(key);
  useEffect(() => {
    // A key bump means "the answer changed": skip the cache. Otherwise a fresh cached answer (or
    // the boot prefetch still in flight) is reused.
    const forced = key !== firstKey.current;
    firstKey.current = key;
    // A new path shows its own cached data if any; otherwise the previous answer stays up as stale.
    const cached = forced ? null : peek<T>(path);
    if (cached)
      setHeld({ data: cached.data, for: pollWant(path, key), saved: cached.restored, at: cached.at });
    setError(null);
    again.current = false;
    run(pollMountMaxAge(path, forced));
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() >= retryAt.current) poll();
    }, intervalMs);
    setSchedule({ from: Date.now() + intervalMs, every: intervalMs });
    // Coming back to the tab refreshes only what has gone stale while it was hidden. Chart paths
    // always poll: history can land in the shared cache while this hook's last response was a tail.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const p = pathRef.current;
      const want = wantRef.current;
      const cached = peek<T>(p);
      if (cached?.data && isChartPollPath(p)) {
        setHeld((h) => {
          if (!h || h.for !== want) {
            return { data: cached.data, for: want, saved: false, at: cached.at };
          }
          const prev = h.data as ChartPollBody;
          const body = cached.data as ChartPollBody;
          if (prev.mint === body.mint && chartHistoryExtended(prev, body)) {
            return { data: cached.data, for: want, saved: false, at: cached.at };
          }
          return h;
        });
      }
      if (shouldPollOnVisible(p, cached?.at ?? null, intervalMs)) poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // Results for this effect's path that land after cleanup must not overwrite the next one.
      seq.current++;
      busy.current = false;
    };
  }, [path, key, intervalMs, run, poll]);

  const data = held?.data ?? null;
  const stale = pollIsStale(held, want);
  // Nothing current to show yet: the page's loading bar waits on this answer.
  const waiting = loading && (data === null || stale);
  useEffect(() => (waiting ? beginWait() : undefined), [waiting, want]);
  return { data, stale, at: held?.at ?? null, error, loading, reload, schedule };
}

/**
 * Several paths polled together, all at once: on mount, when the paths or `key` change, on
 * reload(), and every `intervalMs` while the tab is visible. Each path keeps its last answer
 * (the shared cache's until its own lands, null if neither) while the next is in flight or if it
 * fails. Overlapping reloads
 * coalesce into one follow-up round, as in usePolling.
 */
export function usePollingAll<T>(
  paths: readonly string[],
  intervalMs: number,
  key = "",
): { data: (T | null)[]; error: Error | null; reload: () => void } {
  const [held, setHeld] = useState<ReadonlyMap<string, T>>(() => new Map());
  const [error, setError] = useState<Error | null>(null);
  const joined = paths.join("\n");
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const seq = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);

  const run = useCallback((maxAgeMs: number) => {
    const list = pathsRef.current;
    if (list.length === 0) return;
    const mine = ++seq.current;
    busy.current = true;
    Promise.allSettled(list.map((p) => cachedGet<T>(p, maxAgeMs)))
      .then((results) => {
        if (mine !== seq.current) return;
        setHeld((prev) => {
          const next = new Map(prev);
          results.forEach((r, i) => {
            if (r.status === "fulfilled") next.set(list[i]!, r.value);
          });
          return next;
        });
        const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        setError(
          failed ? (failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))) : null,
        );
      })
      .finally(() => {
        if (mine !== seq.current) return;
        busy.current = false;
        if (again.current) {
          again.current = false;
          run(-1);
        }
      });
  }, []);

  const reload = useCallback(() => {
    if (busy.current) again.current = true;
    else run(-1);
  }, [run]);

  const firstKey = useRef(key);
  const skipCache = useRef(false);
  useEffect(() => {
    const forced = key !== firstKey.current;
    firstKey.current = key;
    if (forced) {
      // The cache holds answers from before the change: don't show them either.
      skipCache.current = true;
      setHeld(new Map());
    }
    again.current = false;
    busy.current = false;
    const list = pathsRef.current;
    run(forced ? -1 : list.some((p) => isChartPollPath(p)) ? 0 : FRESH_ON_MOUNT_MS);
    // As usePolling's timed poll: past the browser's HTTP cache only for reload().
    const poll = () => {
      if (!busy.current) run(0);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, intervalMs);
    // Coming back to the tab refreshes them if any has gone stale while it was hidden, as in
    // usePolling: the hidden tab's timer is throttled or skipped.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const paths = pathsRef.current;
      if (paths.some((p) => shouldPollOnVisible(p, peek<T>(p)?.at ?? null, intervalMs))) poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      seq.current++;
      busy.current = false;
    };
  }, [joined, key, intervalMs, run]);

  // Keyed on the joined paths, not the array, which a caller may rebuild every render. A path with
  // no answer of its own yet shows the shared cache's, so a view coming back (or reading a page it
  // read before) paints at once while the refetch runs, instead of waiting on it.
  const data = useMemo(
    () =>
      joined
        .split("\n")
        .filter(Boolean)
        .map((p) => held.get(p) ?? (skipCache.current ? null : (peek<T>(p)?.data ?? null))),
    [joined, held],
  );
  return { data, error, reload };
}

/** First wait before reopening a dropped nudge stream; doubles per failure up to the cap. */
const STREAM_RETRY_MS = 5_000;
const STREAM_RETRY_MAX_MS = 300_000;
/** The most a broadcast curated nudge is held back on this page - see SharedStream.open. */
const CURATED_NUDGE_SPREAD_MS = 3_000;

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
  private source: { close(): void } | null = null;
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
    const deliver = () => {
      for (const s of [...this.subs]) s.onEvent();
    };
    // A curated call reaches every open dashboard in the same instant, and each one refetching
    // at once landed the whole readership on the API together. Spread over a couple of seconds
    // (one delay per event, so this page's listeners still share their fetches). A match is one
    // reader's own and goes straight through.
    let pending: number | undefined;
    const spread = this.path === "/curated/stream" ? CURATED_NUDGE_SPREAD_MS : 0;
    const fire = () => {
      if (spread === 0) return deliver();
      if (pending !== undefined) return;
      pending = window.setTimeout(() => {
        pending = undefined;
        deliver();
      }, Math.random() * spread);
    };
    const ready = () => {
      this.failures = 0;
      this.setLive(true);
    };
    const failed = () => {
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

    // EventSource can't send headers, so a browser signed in by header (session.ts) reads the
    // stream over fetch instead.
    const token = sessionToken();
    if (token) {
      this.source = fetchEventStream(
        `${API_URL}${this.path}`,
        token,
        (event) => {
          if (event === "ready") ready();
          else fire();
        },
        failed,
      );
      return;
    }

    const es = new EventSource(`${API_URL}${this.path}`, { withCredentials: true });
    this.source = es;
    es.addEventListener("ready", ready);
    es.onmessage = fire;
    es.addEventListener("match", fire);
    es.addEventListener("curated", fire);
    es.onerror = failed;
  }
}

/**
 * A minimal EventSource over fetch, for the header-authenticated case: calls `onEvent` with each
 * event's name ("message" when it has none) and `onError` once if the stream fails or ends. Only
 * event names matter here - the streams are nudges, and the data is always refetched.
 */
function fetchEventStream(
  url: string,
  token: string,
  onEvent: (event: string) => void,
  onError: () => void,
): { close(): void } {
  const controller = new AbortController();
  void (async () => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split("\n").filter((l) => l && !l.startsWith(":"));
        // A block of only "retry:" lines is not an event.
        if (!lines.some((l) => l.startsWith("data") || l.startsWith("event"))) continue;
        const name = lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        onEvent(name || "message");
      }
    }
    throw new Error("stream ended");
  })().catch(() => {
    if (!controller.signal.aborted) onError();
  });
  return { close: () => controller.abort() };
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
/** The least time between two ticks when the tokens on screen change. */
const MIN_RETICK_MS = 3_000;

/**
 * Keeps the "Now" market cap on `cards` seconds old: polls GET /live/market for the tokens on
 * screen every LIVE_TICK_MS while the tab is visible (and at once when they change or the tab
 * comes back), and returns the cards with any newer reading laid over them. The full feed poll is
 * much slower and stays the source of everything else on a card.
 *
 * A failed tick just leaves the last numbers up; the next one tries again.
 */
export function useLiveMarketCaps(
  cards: Card[] | undefined,
  tickTokenIds?: readonly string[],
): Card[] | undefined {
  const [live, setLive] = useState<Map<string, { marketCapUsd: number; at: string; source?: "curve" }>>(
    () => new Map(),
  );
  // `tickTokenIds` narrows the tick to some of the cards (a feed holding more cards than are on
  // screen); the rest keep the feed's own figure.
  const tickIds = tickTokenIds ?? cards?.map((c) => c.tokenId);
  const ids = tickIds ? [...new Set(tickIds)].sort().join(",") : "";
  // Every token the cards hold: a reading is kept while its card is here, ticked or not, so a card
  // that drops out of the tick keeps its last reading instead of jumping back to the feed's older one.
  const held = cards ? [...new Set(cards.map((c) => c.tokenId))].sort().join(",") : "";
  const heldRef = useRef(held);
  heldRef.current = held;
  const lastTickAt = useRef(0);

  useEffect(() => {
    if (!ids) return;
    let stopped = false;
    let busy = false;
    const tick = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      lastTickAt.current = Date.now();
      api<LiveMarket>(`/live/market?tokens=${encodeURIComponent(ids)}`)
        .then((res) => {
          if (stopped) return;
          setLive((prev) => {
            // Only the cards' tokens: a long-open feed must not keep every token it ever showed.
            const keep = new Set([...ids.split(","), ...heldRef.current.split(",")]);
            const next = new Map([...prev].filter(([id]) => keep.has(id)));
            for (const t of res.tokens)
              next.set(t.id, { marketCapUsd: t.marketCapUsd, at: t.at, source: t.source });
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    // A new set of tokens ticks at once, unless a tick just went out: the set can change several
    // times in a row (a page filling in), and each must not cost a request of its own.
    const sinceLast = Date.now() - lastTickAt.current;
    const first =
      sinceLast >= MIN_RETICK_MS ? (tick(), undefined) : window.setTimeout(tick, MIN_RETICK_MS - sinceLast);
    const timer = window.setInterval(tick, LIVE_TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (first !== undefined) window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ids]);

  return useMemo(() => {
    if (!cards || live.size === 0) return cards;
    return cards.map((card) => {
      const reading = live.get(card.tokenId);
      if (!reading) return card;
      // The feed may already carry something newer (a scan snapshot, or a later poll). A curve
      // reading is the market to the block, while the feed's DexScreener figure shows the market of
      // up to a minute before its stamp, so the feed's only wins once it is stamped a minute later.
      const cardAt = card.currentMarketCapAt ? new Date(card.currentMarketCapAt).getTime() : 0;
      const readAt = new Date(reading.at).getTime();
      if (readAt + (reading.source === "curve" ? READING_LAG_MS : 0) <= cardAt) return card;
      return {
        ...card,
        currentMarketCapUsd: reading.marketCapUsd,
        currentMarketCapAt: reading.at,
        currentMarketCapSource: reading.source,
      };
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

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
