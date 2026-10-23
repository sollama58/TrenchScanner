import { useCallback, useEffect, useRef, useState } from "react";
import { api, FEED_TIMEOUT_MS } from "../api";
import { MAX_SLOTS } from "../chartBars";
import type { Point, VolumeCandle } from "../priceChart";

/** Mirrors apps/api/src/liveCurve.ts LiveCurveAnswer. */
export interface LiveCurveAnswer {
  mint: string;
  source: LiveSource;
  /** What prices it now; absent from older API builds (the curve). */
  venue?: "curve" | "pool";
  complete: boolean;
  coveredFrom: number | null;
  readAt: number | null;
  ticks: [number, number][];
  /** The API held the ask for the next change (wait=1); absent from older API builds. */
  held?: boolean;
}
export type LiveSource = "stream" | "rpc" | "pending" | "none";

export interface LiveTail {
  /** Every price change read so far, oldest first: [ms, market cap]. */
  ticks: Point[];
  /** Where the newest came from; null before the first answer. */
  source: LiveSource | null;
  /** The curve, or after bonding the PumpSwap pool. */
  venue: "curve" | "pool";
  /** The newest moment the price is known current (ms). */
  readAt: number | null;
  /**
   * Nothing live prices the coin (not a Pump.fun coin, or no pool to follow), as of the last
   * answer. Asked again every DONE_RECHECK_MS, so a passing "complete" resumes.
   */
  done: boolean;
}

/** How often an open chart asks for its curve's changes, from an API that answers at once. */
export const LIVE_POLL_MS = 2_000;
/**
 * The API holds each ask until the curve's next change (user ask 2026-10-18: the chart trailed
 * by seconds), so the next ask goes out at once, but no sooner than this after the last one went:
 * a busy coin changes every block, and the route allows 120 asks a minute.
 */
const HELD_GAP_MS = 750;
const MAX_BACKOFF_MS = 30_000;
/** How often a tail the API called complete asks again, in case that was passing. */
const DONE_RECHECK_MS = 60_000;
const MAX_TICKS = 6_000;

/**
 * The token chart's live tail (user ask 2026-10-17): while `enabled`, asks `base`/chart/live
 * for the coin's price changes since the last answer (the API follows its bonding curve, or after
 * bonding its PumpSwap pool, on the Helius stream, apps/api/src/liveCurve.ts, and holds the ask
 * until the next change) and
 * keeps them all. Only
 * while the tab is visible; a failure backs off and keeps trying, so the tail resumes on its own.
 */
export function useLiveTail(base: string, enabled: boolean): LiveTail {
  const [tail, setTail] = useState<LiveTail>({
    ticks: [],
    source: null,
    venue: "curve",
    readAt: null,
    done: false,
  });
  const after = useRef(0);

  useEffect(() => {
    setTail({ ticks: [], source: null, venue: "curve", readAt: null, done: false });
    after.current = 0;
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    // A held ask lasts up to 8 s: a closed chart lets go of it at once, not of a browser connection.
    const abort = new AbortController();
    const next = (ms: number) => {
      window.clearTimeout(timer);
      if (!stopped) timer = window.setTimeout(() => void poll(), ms);
    };
    let busy = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return next(LIVE_POLL_MS);
      const sent = Date.now();
      busy = true;
      try {
        const a = await api<LiveCurveAnswer>(`${base}/chart/live?after=${after.current}&wait=1`, {
          signal: abort.signal,
          timeoutMs: FEED_TIMEOUT_MS,
        });
        if (stopped) return;
        failures = 0;
        const fresh = a.ticks
          .filter(([t, v]) => t > after.current && Number.isFinite(v) && v > 0)
          .map(([t, v]) => ({ t, v }));
        if (fresh.length > 0) after.current = fresh[fresh.length - 1]!.t;
        setTail((prev) => ({
          ticks: fresh.length > 0 ? prev.ticks.concat(fresh).slice(-MAX_TICKS) : prev.ticks,
          source: a.source,
          venue: a.venue ?? "curve",
          readAt: a.readAt,
          done: a.complete,
        }));
        // "Nothing live prices it" can pass (a coin between its curve and its pool, the stream
        // reconnecting), so a done tail still asks again now and then and resumes if it has.
        next(
          a.complete
            ? DONE_RECHECK_MS
            : a.held
              ? Math.max(0, HELD_GAP_MS - (Date.now() - sent))
              : LIVE_POLL_MS,
        );
      } catch {
        if (!stopped) next(Math.min(MAX_BACKOFF_MS, LIVE_POLL_MS * 2 ** ++failures));
      } finally {
        busy = false;
      }
    };
    // Back online (a laptop woken, a network switched): ask at once rather than out the backoff.
    const resume = () => {
      if (busy || stopped) return;
      failures = 0;
      next(0);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    void poll();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", onVisible);
      abort.abort();
    };
  }, [base, enabled]);

  return tail;
}

/** One bar of GET /tokens/:mint/candles (core's SeriesBar): market cap in USD on the supply now. */
export interface StoredBar {
  /** The bar's start (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD volume; null where the source didn't say. */
  vol: number | null;
  /** Wider than the timeframe asked for (only coarser data covers its stretch): `w` is its width. */
  coarse?: true;
  /** A coarse bar's real width, in seconds. */
  w?: number;
}

/** Mirrors apps/api/src/tokenCandles.ts TokenCandlesAnswer. */
export interface StoredCandles {
  mint: string;
  tf: string;
  /** Oldest first. */
  bars: StoredBar[];
  /** Pass as `before` for the page before this one; null when nothing older is stored. */
  next: number | null;
}

/** The timeframes the candles route serves, by width (ms): the chart's own (priceChart.ts TIMEFRAMES). */
const CANDLE_TF_PARAM = new Map<number, string>([
  [1_000, "1s"],
  [5_000, "5s"],
  [15_000, "15s"],
  [30_000, "30s"],
  [60_000, "1m"],
  [300_000, "5m"],
  [900_000, "15m"],
  [1_800_000, "30m"],
  [3_600_000, "1h"],
  [14_400_000, "4h"],
]);

/** Exported for tests. The route's `tf` for a width: the narrowest it serves at least that wide. */
export function candleTfParam(tfMs: number): { tf: string; ms: number } {
  for (const [ms, tf] of CANDLE_TF_PARAM) if (ms >= tfMs) return { tf, ms };
  return { tf: "4h", ms: 14_400_000 };
}

/**
 * How often an open chart re-reads its newest page of candles: every few seconds on the finest
 * timeframes (the route keeps that page 3 s), less often wider. The live tail moves the forming
 * candle in between; this poll only settles the closed ones.
 */
export function candlePollMs(tfMs: number): number {
  return tfMs <= 5_000 ? 5_000 : tfMs < 60_000 ? 15_000 : 30_000;
}

/**
 * Exported for tests. A page's bars as the chart's candles at `tfMs`, the bad ones (a value that
 * isn't a positive number) left out. A coarse bar keeps its real width, so the chart draws it that
 * wide and shaded (chartBars.ts buildSlots); one that would run into the next bar (the seam between
 * two pages) is cut at that bar's start.
 */
export function storedCandles(bars: readonly StoredBar[], tfMs: number): VolumeCandle[] {
  const ok = bars.filter(
    (b) => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every((n) => Number.isFinite(n) && n > 0),
  );
  return ok.map((b, i) => {
    let w = b.coarse && b.w ? b.w * 1_000 : tfMs;
    const next = ok[i + 1];
    if (next && b.t + w > next.t) w = Math.max(tfMs, next.t - b.t);
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol ?? null, w };
  });
}

/**
 * Exported for tests. Candles held with a newer page joined: the page stands from its first bar on
 * (its stretch was read afresh, the forming bar included), the held ones before it stay.
 */
export function withNewest(held: readonly VolumeCandle[], page: readonly VolumeCandle[]): VolumeCandle[] {
  if (page.length === 0) return [...held];
  const from = page[0]!.t;
  return held.filter((k) => k.t < from).concat(page);
}

/**
 * Exported for tests. The newest `cap` candles held, and the `before` that reads the page before
 * them: each candle is at least a slot wide, so the chart (MAX_SLOTS) draws none of the ones left
 * out, and a coin left open no longer piles up a candle every poll for as long as it stays open.
 * The cut ones come back as an older page if the reader scrolls back to them.
 */
export function newestHeld(
  candles: VolumeCandle[],
  next: number | null,
  cap = MAX_SLOTS,
): { candles: VolumeCandle[]; next: number | null } {
  if (candles.length <= cap) return { candles, next };
  const kept = candles.slice(-cap);
  return { candles: kept, next: kept[0]!.t };
}

/**
 * Exported for tests. Candles held with an older page joined before them. A coarse bar of the page
 * running past the held first one is cut at its start, as storedCandles cuts a page's own seams.
 */
export function withOlder(held: readonly VolumeCandle[], page: readonly VolumeCandle[]): VolumeCandle[] {
  if (held.length === 0) return [...page];
  const first = held[0]!.t;
  return page
    .filter((k) => k.t < first)
    .map((k) => (k.t + (k.w ?? 0) > first ? { ...k, w: first - k.t } : k))
    .concat(held);
}

/** A coin's candles at one timeframe, as read from the candle store (useStoredCandles). */
export interface CandleHistory {
  tfMs: number;
  /** Oldest first, each with its width (`w`, ms): the timeframe's, or a coarse bar's own. */
  candles: VolumeCandle[];
  /** The `before` for the next older page; null once the store has nothing older. */
  next: number | null;
}

/** An older page that came back empty is asked again after this, on a scroll back to it (a backfill may land). */
const OLDER_RETRY_MS = 60_000;
/** Candles starting this long after the launch don't reach it: worth asking again later. */
const LAUNCH_SLACK_MS = 10 * 60_000;

/**
 * The token chart's candles (GET /tokens/:mint/candles, charts audit 2026-10-22 target design): one
 * timeframe's bars from the server's candle store, which holds each stretch of the coin's history
 * at the finest width it has and backfills to the launch, so the chart no longer stitches widths
 * itself. While `tfMs` is set, the newest page is read now and every candlePollMs after (only while
 * the tab is visible); `older()` reads the page before the oldest held (the chart calls it as the
 * reader scrolls back), so the whole history down to the launch is reachable at any timeframe. A
 * new timeframe keeps the old one's candles up until its first page lands; a failed read keeps
 * what was held and says so in `error`.
 */
export function useStoredCandles(
  base: string,
  tfMs: number | null,
  launchAt: number | null = null,
  limit: number | null = null,
): { history: CandleHistory | null; error: Error | null; at: number | null; older: () => void } {
  const [held, setHeld] = useState<{ base: string; history: CandleHistory } | null>(null);
  const [error, setError] = useState<{ base: string; error: Error } | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const tf = tfMs === null ? null : candleTfParam(tfMs);
  const key = tf ? `${base}|${tf.tf}|${limit ?? ""}` : null;
  // What the paging reads: the candles held for this key, kept current on every render.
  const live = useRef<{ key: string | null; history: CandleHistory | null }>({ key: null, history: null });
  const paging = useRef<{ key: string | null; busy: boolean; emptyAt: number }>({
    key: null,
    busy: false,
    emptyAt: 0,
  });
  const launchRef = useRef(launchAt);
  launchRef.current = launchAt;

  useEffect(() => {
    if (!key || !tf) return;
    paging.current = { key, busy: false, emptyAt: 0 };
    let stopped = false;
    let timer: number | undefined;
    let busy = false;
    const poll = async () => {
      window.clearTimeout(timer);
      busy = true;
      if (document.visibilityState === "visible") {
        try {
          const a = await api<StoredCandles>(
            `${base}/candles?tf=${tf.tf}${limit !== null ? `&limit=${limit}` : ""}`,
            { timeoutMs: FEED_TIMEOUT_MS },
          );
          if (!stopped) {
            const page = storedCandles(a.bars ?? [], tf.ms);
            setHeld((prev) => {
              const mine = prev && prev.base === base && prev.history.tfMs === tf.ms ? prev.history : null;
              const joined = mine ? withNewest(mine.candles, page) : page;
              // Older pages already held keep their own `next`; otherwise the newest page's.
              const pagedBack = !!mine && page.length > 0 && joined[0]!.t < page[0]!.t;
              const held = newestHeld(joined, pagedBack ? mine.next : (a.next ?? null));
              return { base, history: { tfMs: tf.ms, ...held } };
            });
            setError(null);
            setAt(Date.now());
          }
        } catch (e) {
          if (!stopped) setError({ base, error: e instanceof Error ? e : new Error(String(e)) });
        }
      }
      busy = false;
      if (!stopped) timer = window.setTimeout(() => void poll(), candlePollMs(tf.ms));
    };
    // Back online, or the tab shown again: read at once rather than at the next round.
    const resume = () => {
      if (!busy && !stopped) void poll();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") resume();
    };
    void poll();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // `tf` is derived from `key`.
  }, [key, base, limit]);

  const history = held && held.base === base ? held.history : null;
  live.current = { key, history: history && tf && history.tfMs === tf.ms ? history : null };

  const older = useCallback(() => {
    const { key: k, history: h } = live.current;
    const p = paging.current;
    if (!k || !h || h.candles.length === 0 || p.key !== k || p.busy) return;
    const oldest = h.candles[0]!.t;
    let before = h.next;
    if (before === null) {
      // The store had nothing older when last asked. A coin still being backfilled gets more: ask
      // again now and then, while the candles held stop well short of the launch.
      const launch = launchRef.current;
      const short = launch === null || oldest > launch + LAUNCH_SLACK_MS;
      if (!short || Date.now() - p.emptyAt < OLDER_RETRY_MS) return;
      before = oldest;
    }
    const tfMsNow = h.tfMs;
    const param = candleTfParam(tfMsNow).tf;
    p.busy = true;
    void api<StoredCandles>(`${base}/candles?tf=${param}&before=${Math.floor(before)}`, {
      timeoutMs: FEED_TIMEOUT_MS,
    })
      .then((a) => {
        if (paging.current !== p) return;
        const page = storedCandles(a.bars ?? [], tfMsNow);
        if (page.length === 0 || a.next === null) p.emptyAt = Date.now();
        setHeld((prev) => {
          if (!prev || prev.base !== base || prev.history.tfMs !== tfMsNow) return prev;
          return {
            base,
            history: {
              tfMs: tfMsNow,
              candles: withOlder(prev.history.candles, page),
              next: page.length > 0 ? (a.next ?? null) : null,
            },
          };
        });
      })
      .catch(() => {
        // Tried again on the next scroll back.
      })
      .finally(() => {
        p.busy = false;
      });
  }, [base]);

  return { history, error: error && error.base === base ? error.error : null, at, older };
}
