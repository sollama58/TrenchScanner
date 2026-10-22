import { useEffect, useRef, useState } from "react";
import { api, FEED_TIMEOUT_MS } from "../api";
import type { Point } from "../priceChart";

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

/** Mirrors apps/api/src/routes/tokens.ts TokenFineCandles. */
export interface FineCandles {
  mint: string;
  stepSec: 1 | 15;
  candles: { t: number; o: number; h: number; l: number; c: number; vol?: number }[] | null;
  /** "pumpfun", "stream" (the API's own, off the live tail) or "mixed"; absent from older API builds. */
  source?: "pumpfun" | "stream" | "mixed";
  /** Pump.fun's part is its last good answer, past its cache time. */
  stale?: boolean;
}

/** How far before an answer's arrival its Pump.fun part is taken to be current (the API's cache, the browser's). */
const FINE_FRESH_MARGIN_MS = 15_000;

/** The most finer candles a chart keeps from its reads (the chart draws at most 12,000 slots). */
const MAX_FINE_CANDLES = 20_000;

type FineCandle = NonNullable<FineCandles["candles"]>[number];

/**
 * Exported for tests. Two reads of the finer candles as one, by time: the newer read's candle wins
 * a step both hold, and the older read's steps the newer one no longer reaches stay (as
 * chartPoll.ts mergeTokenChart does for the minute candles). The API's 1-second answer turns to the
 * stream's own candles once those reach back far enough, which start only when the chart opened:
 * replacing the page lost Pump.fun's older seconds the view was drawing (charts audit CH-5).
 */
export function mergeFine(prev: FineCandles | null, next: FineCandles): FineCandles {
  if (!prev?.candles?.length || prev.stepSec !== next.stepSec) return next;
  if (!next.candles?.length) return prev;
  const byT = new Map<number, FineCandle>();
  for (const k of prev.candles) byT.set(k.t, k);
  for (const k of next.candles) byT.set(k.t, k);
  const candles = [...byT.values()].sort((a, b) => a.t - b.t).slice(-MAX_FINE_CANDLES);
  return { ...next, candles };
}

/**
 * The token chart's finer candles (GET `base`/chart/fine): Pump.fun's 1- or 15-second page, read
 * when `res` is set (the view is short enough for them to add detail) and every `everyMs` after.
 * Each read is joined to the ones before it (mergeFine), and they stay up through a failed read; a
 * new `res` starts empty. The API answers 1-second candles from its own stream alone once they reach
 * back to `from` without a break: that is where the Pump.fun pages held here are current to (a
 * little before the last one arrived), so the stream's candles join them with no hole and the
 * Pump.fun budget isn't spent again; with none held yet, the view's start (`from`), so Pump.fun's
 * page is read first.
 */
export function useFineCandles(
  base: string,
  res: "1s" | "15s" | null,
  everyMs: number,
  from: number | null = null,
): FineCandles | null {
  const [held, setHeld] = useState<{ key: string; data: FineCandles } | null>(null);
  const key = `${base}|${res}`;
  // Read at each poll, so a view start that moves doesn't restart the polling.
  const fromRef = useRef(from);
  fromRef.current = from;
  useEffect(() => {
    // Where the Pump.fun pages read so far are current to (ms), null before one lands.
    let through: number | null = null;
    if (!res) return;
    let stopped = false;
    let timer: number | undefined;
    let busy = false;
    const poll = async () => {
      window.clearTimeout(timer);
      busy = true;
      if (document.visibilityState === "visible") {
        try {
          const at = through ?? fromRef.current;
          const data = await api<FineCandles>(
            `${base}/chart/fine?res=${res}${at !== null && at > 0 ? `&from=${Math.floor(at)}` : ""}`,
            { timeoutMs: FEED_TIMEOUT_MS },
          );
          if (data.candles?.length && data.source !== "stream" && !data.stale)
            through = Date.now() - FINE_FRESH_MARGIN_MS;
          // An answer with no candles (over budget, upstream paused) keeps what was read before.
          if (!stopped)
            setHeld((prev) => ({ key, data: mergeFine(prev?.key === key ? prev.data : null, data) }));
        } catch {
          // The view keeps its minute candles meanwhile; the next round tries again.
        }
      }
      busy = false;
      if (!stopped) timer = window.setTimeout(() => void poll(), everyMs);
    };
    // Back online: read at once rather than at the next round.
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
  }, [base, res, key, everyMs]);
  return held && held.key === key ? held.data : null;
}
