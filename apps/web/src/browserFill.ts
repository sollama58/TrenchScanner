import { useEffect, useRef, useState } from "react";
import { parseOhlcv, type BackupCandle } from "./backupCandles";
import type { VolumeCandle } from "./priceChart";

/**
 * The chart's fill (user ask 2026-10-24: "see if there is a better way to backfill the data; such
 * as having any requests sent from the user's frontend"): the stretches the candle store has
 * nothing for (its answer's `holes`) are read by the reader's browser itself, from GeckoTerminal's
 * free minute candles on the reader's own connection and its own rate limit, so they draw within
 * seconds of opening the chart rather than waiting on the server's backfill queue and its shared
 * budget. The server still backfills them into the store for everyone (candleBackfill.ts, the
 * API's top-up); what the browser reads is drawn, never sent back (a reader's answer can't be
 * trusted into the store).
 *
 * Its progress is measured, not guessed: the share of the missing minutes either read or found
 * to have no data, and an ETA from the pages still to read at the pace the reads go out.
 */

const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";
const MINUTE_MS = 60_000;
/** Minutes a GeckoTerminal page holds at most (its trading minutes; quiet ones are left out). */
const PAGE_MINUTES = 1_000;
/** GeckoTerminal's free limit is 30 calls a minute per address: a read every 2.2 s stays under it. */
export const FILL_PACE_MS = 2_200;
/** A missing stretch shorter than this is left alone (GeckoTerminal's candles are minutes). */
const MIN_TARGET_MS = 2 * MINUTE_MS;
/** GeckoTerminal's newest minutes can trail by a minute or two: nothing newer is vouched for. */
const SETTLE_MS = 3 * MINUTE_MS;
/** Pages read for one stretch at most (1,000 minutes each: about two weeks of trading). */
const MAX_PAGES = 20;
/** A failed read is tried again after this, this many times. */
const RETRY_MS = 10_000;
const RETRIES = 3;
const TIMEOUT_MS = 10_000;

/** [from, to) in ms. */
export type Span = [number, number];

/** The API's `fill`: the coin's pools in the backfill's order and its market cap per USD of price. */
export interface FillSource {
  pools: string[];
  scale: number;
}

export interface FillState {
  /** The minute candles read, as market cap in USD, oldest first. */
  bars: BackupCandle[];
  /** The stretches the reads vouch for: each minute in them is a read candle or had no trade. */
  covered: Span[];
  /** Stretches no pool had anything for: drawn as "No data recorded". */
  dead: Span[];
  /** The missing time asked for (ms), and how much of it is read or found empty. */
  totalMs: number;
  doneMs: number;
  /** Pages still to read at most, and when that will be done at the reads' pace (ms epoch). */
  pagesLeft: number;
  doneAt: number | null;
}

export const EMPTY_FILL: FillState = {
  bars: [],
  covered: [],
  dead: [],
  totalMs: 0,
  doneMs: 0,
  pagesLeft: 0,
  doneAt: null,
};

/** Spans sorted and joined where they touch or overlap. */
export function joinSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** `spans` with `cut` taken out. */
export function subtract(spans: readonly Span[], cut: readonly Span[]): Span[] {
  const cuts = joinSpans(cut);
  const out: Span[] = [];
  for (const [a0, b] of spans) {
    let a = a0;
    for (const [c, d] of cuts) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/** How much of `spans` lies inside `within` (ms). */
export function overlapMs(spans: readonly Span[], within: readonly Span[]): number {
  const w = joinSpans(within);
  let sum = 0;
  for (const [a, b] of joinSpans(spans))
    for (const [c, d] of w) sum += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return sum;
}

/**
 * Exported for tests. The holes worth reading: whole minutes, MIN_TARGET_MS or longer, up to
 * SETTLE_MS ago, and not read or found empty already.
 */
export function fillTargets(holes: readonly Span[], done: readonly Span[], now: number): Span[] {
  const settled = Math.floor((now - SETTLE_MS) / MINUTE_MS) * MINUTE_MS;
  const whole = holes.map(([a, b]): Span => [
    Math.ceil(a / MINUTE_MS) * MINUTE_MS,
    Math.min(settled, Math.floor(b / MINUTE_MS) * MINUTE_MS),
  ]);
  return subtract(joinSpans(whole), done).filter(([a, b]) => b - a >= MIN_TARGET_MS);
}

/** Pages a stretch of `ms` takes at most. */
const pagesFor = (ms: number) => Math.max(1, Math.ceil(ms / (PAGE_MINUTES * MINUTE_MS)));

/**
 * Exported for tests. Reads one stretch's minutes, newest page first, on the coin's pools in order:
 * a pool with nothing (more) before the cursor hands the rest to the next pool (a graduated coin's
 * curve holds its history before its pool). `read(pool, beforeSec)` is one GeckoTerminal page.
 * Each page's outcome goes to `step`.
 */
export async function readStretch(
  target: Span,
  src: FillSource,
  read: (pool: string, beforeSec: number) => Promise<unknown>,
  step: (out: { bars: BackupCandle[]; covered: Span | null; dead: Span | null; cursor: number }) => void,
  now: number,
  stopped: () => boolean,
): Promise<void> {
  const [a, b] = target;
  let cursor = b;
  let pool = 0;
  for (let page = 0; page < MAX_PAGES && cursor > a && !stopped(); page++) {
    const p = src.pools[pool];
    if (!p) break;
    const bars = parseOhlcv(await read(p, Math.floor(cursor / 1_000)), src.scale).filter(
      (k) => k.t < cursor && k.t + MINUTE_MS <= now,
    );
    if (stopped()) return;
    if (bars.length === 0) {
      // Nothing before the cursor on this pool: the next one, from the same place.
      pool += 1;
      step({ bars: [], covered: null, dead: null, cursor });
      continue;
    }
    const oldest = bars[0]!.t;
    // A full page may stop short of the stretch's start: the next page from its oldest minute.
    // A short one is the pool's whole history before the cursor: the rest is the next pool's.
    const full = bars.length >= PAGE_MINUTES;
    step({ bars: bars.filter((k) => k.t >= a), covered: [Math.max(a, oldest), cursor], dead: null, cursor });
    cursor = oldest;
    if (!full) pool += 1;
  }
  if (cursor > a && !stopped()) step({ bars: [], covered: null, dead: [a, cursor], cursor: a });
}

/** The reads' shared pace: one GeckoTerminal call every FILL_PACE_MS from this page. */
let nextSlot = 0;
function slot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + FILL_PACE_MS;
  return new Promise((r) => window.setTimeout(r, at - now));
}

async function geckoPage(mint: string, pool: string, beforeSec: number): Promise<unknown> {
  for (let tries = 0; ; tries++) {
    await slot();
    try {
      const res = await fetch(
        `${GECKOTERMINAL}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=1` +
          `&limit=${PAGE_MINUTES}&before_timestamp=${beforeSec}&currency=usd&token=${encodeURIComponent(mint)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      // An unknown pool: nothing there.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (tries + 1 >= RETRIES) throw err;
      await new Promise((r) => window.setTimeout(r, RETRY_MS));
    }
  }
}

/** Exported for tests. The progress of the stretches asked for, given what is read so far. */
export function progressOf(
  targets: readonly Span[],
  covered: readonly Span[],
  dead: readonly Span[],
  now: number,
  waitMs: number,
): Pick<FillState, "totalMs" | "doneMs" | "pagesLeft" | "doneAt"> {
  const totalMs = joinSpans(targets).reduce((s, [a, b]) => s + b - a, 0);
  const done = joinSpans([...covered, ...dead]);
  const doneMs = overlapMs(done, targets);
  const left = subtract(joinSpans(targets), done);
  const pagesLeft = left.reduce((s, [a, b]) => s + pagesFor(b - a), 0);
  return {
    totalMs,
    doneMs,
    pagesLeft,
    doneAt: pagesLeft > 0 ? now + waitMs + pagesLeft * FILL_PACE_MS : null,
  };
}

/**
 * The fill of `mint`'s `holes` from `src` (the API's `fill`), while `src` is set. The state is the
 * coin's for as long as the chart is open on it: a stretch read or found empty is not read again.
 */
export function useBrowserFill(mint: string, holes: readonly Span[], src: FillSource | null): FillState {
  const [state, setState] = useState<{ mint: string; fill: FillState } | null>(null);
  const run = useRef<{
    mint: string;
    targets: Span[];
    covered: Span[];
    dead: Span[];
    bars: Map<number, BackupCandle>;
    busy: boolean;
    stop: boolean;
  } | null>(null);
  const srcKey = src ? `${src.pools.join(",")}|${src.scale}` : "";
  const holesKey = holes.map(([a, b]) => `${a}-${b}`).join(",");

  // A new coin starts over; leaving it stops its reads.
  useEffect(() => {
    run.current = { mint, targets: [], covered: [], dead: [], bars: new Map(), busy: false, stop: false };
    return () => {
      if (run.current) run.current.stop = true;
    };
  }, [mint]);

  useEffect(() => {
    const r = run.current;
    if (!r || r.mint !== mint || !src) return;
    const fresh = fillTargets(holes, [...r.targets, ...r.covered, ...r.dead], Date.now());
    if (fresh.length === 0) return;
    r.targets = joinSpans([...r.targets, ...fresh]);
    const publish = (waitMs: number) => {
      if (r.stop) return;
      const bars = [...r.bars.values()].sort((x, y) => x.t - y.t);
      const fill: FillState = {
        bars,
        covered: joinSpans(r.covered),
        dead: joinSpans(r.dead),
        ...progressOf(r.targets, r.covered, r.dead, Date.now(), waitMs),
      };
      setState({ mint, fill });
    };
    publish(Math.max(0, nextSlot - Date.now()));
    if (r.busy) return;
    r.busy = true;
    void (async () => {
      // Newest first: what the reader looks at on opening is the latest stretch.
      for (;;) {
        const todo = subtract(r.targets, [...r.covered, ...r.dead]).sort((x, y) => y[1] - x[1]);
        const next = todo[0];
        if (!next || r.stop) break;
        try {
          await readStretch(
            next,
            src,
            (pool, beforeSec) => geckoPage(mint, pool, beforeSec),
            (out) => {
              for (const k of out.bars) r.bars.set(k.t, k);
              if (out.covered) r.covered.push(out.covered);
              if (out.dead) r.dead.push(out.dead);
              publish(Math.max(0, nextSlot - Date.now()));
            },
            Date.now(),
            () => r.stop,
          );
        } catch {
          // GeckoTerminal didn't answer: the stretch is left, drawn as having no data.
          r.dead.push(next);
          publish(0);
        }
      }
      r.busy = false;
    })();
    // `holes` and `src` are keyed.
  }, [mint, holesKey, srcKey]);

  return state && state.mint === mint ? state.fill : EMPTY_FILL;
}

/**
 * Exported for tests. The store's candles with the fill's read minutes in the holes: at a timeframe
 * under a minute each minute is drawn at its width (shaded, as the store's coarse bars are); at a
 * minute or more they are folded into the timeframe's candles. A slot the store has a candle in
 * keeps the store's.
 */
export function withFilled(
  candles: readonly VolumeCandle[],
  tfMs: number,
  bars: readonly BackupCandle[],
): VolumeCandle[] {
  if (bars.length === 0) return candles as VolumeCandle[];
  const taken = candles.map((k) => [k.t, k.t + (k.w ?? tfMs)] as Span);
  const free = (t: number, w: number) => !taken.some(([a, b]) => a < t + w && t < b);
  const added: VolumeCandle[] = [];
  if (tfMs < MINUTE_MS) {
    for (const k of bars) if (free(k.t, MINUTE_MS)) added.push({ ...k, w: MINUTE_MS });
  } else {
    const buckets = new Map<number, VolumeCandle>();
    for (const k of bars) {
      const t = Math.floor(k.t / tfMs) * tfMs;
      const b = buckets.get(t);
      if (!b) buckets.set(t, { t, o: k.o, h: k.h, l: k.l, c: k.c, vol: k.vol, w: tfMs });
      else {
        b.h = Math.max(b.h ?? b.c, k.h);
        b.l = Math.min(b.l ?? b.c, k.l);
        b.c = k.c;
        b.vol = b.vol === null || k.vol === null ? (b.vol ?? k.vol) : b.vol + k.vol;
      }
    }
    for (const b of buckets.values()) if (free(b.t, tfMs)) added.push(b);
  }
  if (added.length === 0) return candles as VolumeCandle[];
  return [...candles, ...added].sort((x, y) => x.t - y.t);
}

/** The progress line's numbers: minutes read or found empty of those missing, and the time left. */
export function fillLine(
  fill: FillState,
  now = Date.now(),
): { done: number; total: number; leftMs: number | null } {
  return {
    done: Math.round(fill.doneMs / MINUTE_MS),
    total: Math.round(fill.totalMs / MINUTE_MS),
    leftMs: fill.doneAt === null ? null : Math.max(0, fill.doneAt - now),
  };
}
