import { useEffect, useRef, useState } from "react";
import { api } from "../api";
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
    const poll = async () => {
      if (document.visibilityState !== "visible") return next(LIVE_POLL_MS);
      const sent = Date.now();
      try {
        const a = await api<LiveCurveAnswer>(`${base}/chart/live?after=${after.current}&wait=1`, {
          signal: abort.signal,
        });
        if (stopped) return;
        failures = 0;
        const fresh = a.ticks.filter(([t]) => t > after.current).map(([t, v]) => ({ t, v }));
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
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
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
}

/**
 * The token chart's finer candles (GET `base`/chart/fine): Pump.fun's 1- or 15-second page, read
 * when `res` is set (the view is short enough for them to add detail) and every `everyMs` after.
 * The last answer for this `res` stays up through a failed read; a new `res` starts empty.
 */
export function useFineCandles(base: string, res: "1s" | "15s" | null, everyMs: number): FineCandles | null {
  const [held, setHeld] = useState<{ key: string; data: FineCandles } | null>(null);
  const key = `${base}|${res}`;
  useEffect(() => {
    if (!res) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const data = await api<FineCandles>(`${base}/chart/fine?res=${res}`);
          if (!stopped) setHeld({ key, data });
        } catch {
          // The view keeps its minute candles meanwhile; the next round tries again.
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), everyMs);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [base, res, key, everyMs]);
  return held && held.key === key ? held.data : null;
}
