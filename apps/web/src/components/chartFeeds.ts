import { useCallback, useEffect, useRef, useState } from "react";
import { api, FEED_TIMEOUT_MS } from "../api";
import { MAX_SLOTS, type Slots } from "../chartBars";
import type { FillSource } from "../browserFill";
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
  /**
   * Stretches from the first bar on that no source read, [from, to) in ms; absent from older API
   * builds and when there are none. The chart leaves them blank rather than flat (chartBars.ts).
   */
  holes?: [number, number][];
  /** With holes: where the browser reads them itself (browserFill.ts). */
  fill?: FillSource;
  /**
   * The newest page: the stretch the coin's stored sub-minute bars cover, [from, to] in ms; absent
   * with none and from older API builds. The picker offers 1s to 30s by it (chartBars.ts).
   */
  fine?: [number, number];
}

/** Exported for tests. An answer's `fine` stretch, checked; null when absent or malformed. */
export function fineCover(fine: unknown): { from: number; to: number } | null {
  if (!Array.isArray(fine) || fine.length !== 2) return null;
  const [from, to] = fine as unknown[];
  return typeof from === "number" && typeof to === "number" && Number.isFinite(from) && to > from
    ? { from, to }
    : null;
}

/** A stretch nobody read: [from, to) in ms. */
export type Hole = [number, number];

/**
 * Exported for tests. The holes held with a newer page's joined: the page's own stand over its
 * span (from its first bar on: a hole a later read filled is gone), the held ones before it stay.
 */
export function holesWithNewest(
  held: readonly Hole[],
  page: readonly Hole[],
  pageFrom: number | null,
): Hole[] {
  if (pageFrom === null) return [...held];
  return held
    .filter(([a]) => a < pageFrom)
    .map(([a, b]): Hole => [a, Math.min(b, pageFrom)])
    .concat(page);
}

/** Exported for tests. The holes held with an older page's joined before them. */
export function holesWithOlder(
  held: readonly Hole[],
  page: readonly Hole[],
  heldFrom: number | null,
): Hole[] {
  if (heldFrom === null) return [...held];
  return page
    .filter(([a]) => a < heldFrom)
    .map(([a, b]): Hole => [a, Math.min(b, heldFrom)])
    .concat(held);
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

/** A newest page's hole at least this long is filled by the API's top-up on the chart's open. */
const TOP_UP_HOLE_MS = 2 * 60_000;
/** How soon the chart reads again while that top-up may still be landing, and how many times. */
export const QUICK_POLL_MS = 3_000;
export const QUICK_POLLS = 3;

/** Exported for tests. When the chart reads its newest page again: soon while the API's top-up may still be landing. */
export function nextPollMs(tfMs: number, quick: boolean): number {
  return quick ? Math.min(candlePollMs(tfMs), QUICK_POLL_MS) : candlePollMs(tfMs);
}

/**
 * Exported for tests. Whether the newest page still waits on the API's top-up (apps/api
 * candleTopUp.ts): no bars, or a long hole in its last 1,000 minutes. The API waits a few seconds
 * for that read and saves it after; the chart reads again in QUICK_POLL_MS then, not its usual
 * round (30 s at 1m: user ask 2026-10-24).
 */
export function awaitsTopUp(
  bars: readonly unknown[],
  holes: readonly (readonly [number, number])[],
  now = Date.now(),
): boolean {
  if (bars.length === 0) return true;
  return holes.some(([a, b]) => b - a >= TOP_UP_HOLE_MS && b > now - 1_000 * 60_000);
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
 * Exported for tests. Candles held with a newer page joined: the page's bars stand (their stretch
 * was read afresh, the forming bar included), and a held bar stays wherever no bar of the page
 * overlaps it. A page that came back thinner (a source that answered a moment ago didn't this
 * time) no longer takes bars already drawn off the chart: that left stretches flat until the next
 * poll (chart gaps audit 2026-10-23). A trade that happened stays happened.
 */
export function withNewest(held: readonly VolumeCandle[], page: readonly VolumeCandle[]): VolumeCandle[] {
  if (page.length === 0) return [...held];
  if (held.length === 0) return [...page];
  const out: VolumeCandle[] = [];
  let j = 0;
  for (const k of held) {
    const end = k.t + (k.w ?? 60_000);
    // Page bars are oldest first and don't overlap each other: skip those ending by this one's start.
    while (j < page.length && page[j]!.t + (page[j]!.w ?? 60_000) <= k.t) j++;
    const p = page[j];
    if (!p || p.t >= end) out.push(k);
  }
  return out.concat(page).sort((a, b) => a.t - b.t);
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
  /** Stretches no source read, oldest first: drawn blank, not flat. */
  holes: Hole[];
  /** Where the browser reads the holes itself (browserFill.ts); null when the answer had none. */
  fill: FillSource | null;
  /**
   * The stretch the store holds bars finer than a minute for, whatever size was read (the newest
   * page's `fine`); null with none reported.
   */
  fine: { from: number; to: number } | null;
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
    let quickLeft = QUICK_POLLS;
    const poll = async () => {
      window.clearTimeout(timer);
      busy = true;
      let quick = false;
      if (document.visibilityState === "visible") {
        try {
          const a = await api<StoredCandles>(
            `${base}/candles?tf=${tf.tf}${limit !== null ? `&limit=${limit}` : ""}`,
            { timeoutMs: FEED_TIMEOUT_MS },
          );
          if (!stopped) {
            const page = storedCandles(a.bars ?? [], tf.ms);
            quick = quickLeft > 0 && awaitsTopUp(a.bars ?? [], a.holes ?? []);
            if (quick) quickLeft -= 1;
            setHeld((prev) => {
              const mine = prev && prev.base === base && prev.history.tfMs === tf.ms ? prev.history : null;
              const joined = mine ? withNewest(mine.candles, page) : page;
              // Older pages already held keep their own `next`; otherwise the newest page's.
              const pagedBack = !!mine && page.length > 0 && joined[0]!.t < page[0]!.t;
              const held = newestHeld(joined, pagedBack ? mine.next : (a.next ?? null));
              const holes = holesWithNewest(mine?.holes ?? [], a.holes ?? [], page[0]?.t ?? null);
              const fill = a.fill ?? mine?.fill ?? null;
              const fine = fineCover(a.fine) ?? mine?.fine ?? null;
              return { base, history: { tfMs: tf.ms, ...held, holes, fill, fine } };
            });
            setError(null);
            setAt(Date.now());
          }
        } catch (e) {
          if (!stopped) setError({ base, error: e instanceof Error ? e : new Error(String(e)) });
        }
      }
      busy = false;
      if (!stopped) timer = window.setTimeout(() => void poll(), nextPollMs(tf.ms, quick));
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
              holes: holesWithOlder(prev.history.holes, a.holes ?? [], prev.history.candles[0]?.t ?? null),
              fill: prev.history.fill ?? a.fill ?? null,
              fine: prev.history.fine,
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

/**
 * Exported for tests. The slots' runs of unknown ones (no source read them), by their edges' times;
 * `dead` where the run lies in a stretch no source had (`dead`, browserFill.ts).
 */
export function slotGaps(
  slots: Slots,
  dead: readonly (readonly [number, number])[] = [],
): { t0: number; t1: number; dead: boolean }[] {
  const out: { t0: number; t1: number; dead: boolean }[] = [];
  const push = (i0: number, i1: number) => {
    const t0 = slots.start + i0 * slots.tfMs;
    const t1 = slots.start + i1 * slots.tfMs;
    const mid = (t0 + t1) / 2;
    out.push({ t0, t1, dead: dead.some(([a, b]) => a <= mid && mid < b) });
  };
  let from: number | null = null;
  slots.bars.forEach((b, i) => {
    if (b.unknown && from === null) from = i;
    if (!b.unknown && from !== null) {
      push(from, i);
      from = null;
    }
  });
  if (from !== null) push(from, slots.bars.length);
  return out;
}
