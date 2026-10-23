import {
  chunkBars,
  chunkStartOf,
  createLogger,
  CURVE_GAP_MS,
  saveCandleChunks,
  type CandleChunkRow,
  type CandleStoreSource,
  type CurveTape,
  type StoredBar,
} from "@trenchscanner/core";

const logger = createLogger("curve-candles");

/**
 * The chart's own 1-second candles (charts audit 2026-10-22 target design, user decision "Store
 * candles + backfill"): the curve tape (curveTape.ts) already follows every tracked Pump.fun coin
 * from about its launch on the Helius stream, so its changes are folded into 1-second OHLC bars and
 * saved to the candle store (CandleChunk) once a minute, one minute of a coin per row. No upstream
 * call and no Helius credit: it reads only what the tape holds. Volume is the SOL that moved through
 * the curve between changes (its real SOL reserve, out or in), at SOL's price at the flush.
 *
 * Only a stretch the stream delivered is saved: a tape read by RPC every few seconds would make
 * "1-second" bars of 5-second samples (charts audit CH-6). A curve quoted in another coin is left
 * out (its reserve is not SOL). After graduation the tape follows the coin's PumpSwap pool, whose
 * bars are saved the same way under "pool" (curveTape.ts).
 */

/** Pump.fun's curve price is lamports per raw token unit: times this, SOL per whole token x one billion. */
const MCAP_SOL_PER_PRICE = 1e6;
const FLUSH_MS = 60_000;
/** Rows a dropped coin's last bars may queue at most before the next flush writes them. */
const MAX_DROPPED = 2_000;

type TapeTicks = ReturnType<CurveTape["ticksAfter"]>;
type Tick = { at: number; price: number; realQuote: number };

/** What the writer reads of the curve tape: the coins followed and their changes. */
export interface CurveTapeView {
  mints(): Iterable<string>;
  ticksAfter(mint: string, after: number): TapeTicks;
  /** What a coin's changes are read off: its curve, or after graduation its pool. Absent: the curve. */
  sourceOf?(mint: string): TapeSource;
}

/** The store sources the tape's bars are saved under. */
type TapeSource = Extract<CandleStoreSource, "curve" | "pool">;

/**
 * Exported for tests. 1-second market-cap bars (USD, on the launch billion) over [from, to) from a
 * curve's changes, oldest first. Each opens at the price in force when its second began (the last
 * change before it), so bars join up; a second with no change has no bar, as Pump.fun's candles
 * leave quiet intervals out, and the tape's first reading is where it starts, not a bar. Volume:
 * the SOL reserve's moves inside the second, in USD.
 */
export function curveBars(ticks: readonly Tick[], from: number, to: number, solUsd: number): StoredBar[] {
  const toMcap = (price: number) => price * MCAP_SOL_PER_PRICE * solUsd;
  const out: StoredBar[] = [];
  let prev: Tick | null = null;
  for (const k of ticks) {
    if (k.at >= to) break;
    // Before the stretch, or the cover's first reading: the starting state, not a change into it.
    if (k.at < from || !prev) {
      prev = k;
      continue;
    }
    const t = Math.floor(k.at / 1_000) * 1_000;
    const v = toMcap(k.price);
    let bar = out[out.length - 1];
    if (!bar || bar.t !== t) {
      const o = toMcap(prev.price);
      bar = { t, o, h: Math.max(o, v), l: Math.min(o, v), c: v, vol: 0 };
      out.push(bar);
    }
    bar.h = Math.max(bar.h, v);
    bar.l = Math.min(bar.l, v);
    bar.c = v;
    bar.vol! += (Math.abs(k.realQuote - prev.realQuote) / 1e9) * solUsd;
    prev = k;
  }
  return out;
}

/**
 * A quiet stretch after a coin's last bar is vouched for by that bar's chunk, its cover run on over
 * it, for at most this long: the chunk is rebuilt from the tape each flush, which keeps half an hour.
 */
const QUIET_COVER_MS = 25 * 60_000;

/**
 * Exported for tests. A coin's chunk rows from what the tape holds after `flushedTo` (null: nothing
 * saved yet), up to `closeAt`, and where the next flush picks up. The chunk `flushedTo` is in is
 * built again whole, so a minute saved in part is rewritten with all its bars (the store keeps the
 * fuller reading). Null when there is nothing to save.
 *
 * Minutes with no change have no bars, so no chunk of their own: the last chunk's cover runs on to
 * the close instead (the store reads a chunk's cover past its own minute), and the next flush picks
 * up at that chunk, so a quiet minute reads as quiet, not as a stretch nobody read (the chart draws
 * those blank: GET /tokens/:mint/candles `holes`).
 */
export function curveCandleRows(
  mint: string,
  tape: TapeTicks,
  flushedTo: number | null,
  closeAt: number,
  solUsd: number,
  source: TapeSource = "curve",
): { rows: CandleChunkRow[]; flushedTo: number } | null {
  if (!tape || !tape.quoteIsSol || tape.streamFrom === null) return null;
  const covered = Math.max(tape.coveredFrom, tape.streamFrom);
  const from = Math.max(covered, flushedTo === null ? covered : chunkStartOf(flushedTo, 1));
  const to = Math.floor(Math.min(closeAt, tape.confirmedAt) / 1_000) * 1_000;
  if (!(to > from)) return null;
  const ticks = tape.prior ? [tape.prior, ...tape.ticks] : tape.ticks;
  const bars = curveBars(ticks, from, to, solUsd);
  const rows = chunkBars(mint, 1, source, bars, { from, to });
  const last = rows[rows.length - 1];
  if (!last || last.coverTo >= to) return { rows, flushedTo: to };
  if (to - last.startAt > QUIET_COVER_MS) return { rows, flushedTo: to };
  last.coverTo = to;
  return { rows, flushedTo: last.startAt };
}

/** Where a coin's tape is read from: the start of the chunk its saved bars end in (all of it at first). */
function readAfter(flushedTo: number | null): number {
  return flushedTo === null ? -1 : chunkStartOf(flushedTo, 1) - 1;
}

interface WriterConfig {
  view: CurveTapeView;
  /** SOL's USD price; the flush waits for one (the tape keeps half an hour). */
  solUsd: () => Promise<number | null>;
  save?: (rows: CandleChunkRow[]) => Promise<unknown>;
}

let cfg: WriterConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
/** Per followed coin, where its saved bars end (ms). */
const flushed = new Map<string, number>();
/** Per followed coin, the last chunk written: rebuilt unchanged, it isn't written again. */
const lastWritten = new Map<string, { startAt: number; coverFrom: number; coverTo: number; bars: number }>();
const sameRow = (
  a: CandleChunkRow,
  b: { startAt: number; coverFrom: number; coverTo: number; bars: number } | undefined,
) =>
  !!b &&
  a.startAt === b.startAt &&
  a.coverFrom === b.coverFrom &&
  a.coverTo === b.coverTo &&
  a.bars.length === b.bars;
/** The last bars of coins the tape let go of, written with the next flush. */
let dropped: CandleChunkRow[] = [];
let lastSolUsd: number | null = null;
let stats = { coins: 0, rows: 0, failed: 0 };

/**
 * Starts the minute flush; returns its stop, which writes what is left. The worker calls the stop
 * before the tape's: the last flush reads the tape at once, then waits out a write in flight.
 */
export function startCurveCandles(config: WriterConfig) {
  cfg = config;
  timer = setInterval(() => void flushCurveCandles(), FLUSH_MS);
  timer.unref?.();
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await flushCurveCandles(Date.now(), true);
    cfg = null;
  };
}

/**
 * The tape is letting go of `mint` (aged out, off the watchlist, graduated): its bars since the
 * last flush are queued for the next one. Called by curveTape.ts before it forgets the coin.
 */
export function curveTapeDropped(
  mint: string,
  tape: Pick<CurveTape, "ticksAfter">,
  now = Date.now(),
  source: TapeSource = "curve",
): void {
  const done = flushed.get(mint) ?? null;
  flushed.delete(mint);
  lastWritten.delete(mint);
  if (!cfg || lastSolUsd === null) return;
  const held = tape.ticksAfter(mint, readAfter(done));
  // Let go of now: what it held is known through now, when the tape was current lately.
  const known = held && now - held.confirmedAt <= CURVE_GAP_MS ? { ...held, confirmedAt: now } : held;
  const out = curveCandleRows(mint, known, done, now, lastSolUsd, source);
  if (out && dropped.length + out.rows.length <= MAX_DROPPED) dropped.push(...out.rows);
}

/**
 * Saves every followed coin's closed seconds up to the last whole minute (`all`: up to the last
 * whole second, for the stop) in batched inserts. A coin whose write failed is tried again from
 * the same place next minute, while the tape still holds it.
 */
export function flushCurveCandles(now = Date.now(), all = false): Promise<void> {
  // The stop's flush doesn't join one in flight: it reads the tape now and writes after it.
  if (flushing && !all) return flushing;
  if (!cfg) return Promise.resolve();
  const before = flushing;
  const config = cfg;
  // What the tape holds is read now, before any wait: the stop's flush runs as the tape stops.
  const followed = new Set(config.view.mints());
  const tapes = [...followed].map((mint) => {
    const done = flushed.get(mint) ?? null;
    const source = config.view.sourceOf?.(mint) ?? "curve";
    return { mint, done, source, tape: config.view.ticksAfter(mint, readAfter(done)) };
  });
  for (const mint of flushed.keys()) if (!followed.has(mint)) flushed.delete(mint);
  for (const mint of lastWritten.keys()) if (!followed.has(mint)) lastWritten.delete(mint);
  const run = (async () => {
    if (before) await before;
    const sol = await config.solUsd().catch(() => null);
    if (sol !== null && sol > 0) lastSolUsd = sol;
    if (lastSolUsd === null) return;
    const closeAt = all ? Math.floor(now / 1_000) * 1_000 : Math.floor(now / FLUSH_MS) * FLUSH_MS;
    const rows: CandleChunkRow[] = dropped;
    dropped = [];
    const next = new Map<string, number>();
    const newest = new Map<string, CandleChunkRow>();
    for (const { mint, done, source, tape } of tapes) {
      const out = curveCandleRows(mint, tape, done, closeAt, lastSolUsd, source);
      if (!out) continue;
      // The chunk picked up from, rebuilt as it was written: not written again.
      const fresh = out.rows.filter((r) => !sameRow(r, lastWritten.get(mint)));
      rows.push(...fresh);
      next.set(mint, out.flushedTo);
      const last = out.rows[out.rows.length - 1];
      if (last) newest.set(mint, last);
    }
    if (rows.length === 0) {
      for (const [mint, to] of next) flushed.set(mint, to);
      return;
    }
    try {
      await (config.save ?? saveCandleChunks)(rows);
      for (const [mint, to] of next) flushed.set(mint, to);
      for (const [mint, r] of newest)
        lastWritten.set(mint, {
          startAt: r.startAt,
          coverFrom: r.coverFrom,
          coverTo: r.coverTo,
          bars: r.bars.length,
        });
      stats.coins += next.size;
      stats.rows += rows.length;
    } catch (err) {
      stats.failed += rows.length;
      logger.warn("curve candles not written", { rows: rows.length, error: String(err) });
    }
  })().finally(() => {
    flushing = null;
  });
  flushing = run;
  return run;
}

/** Counts since the last call, for the scan's heartbeat; null while the writer is off. */
export function takeCurveCandleStats() {
  if (!cfg) return null;
  const out = { ...stats, following: flushed.size };
  stats = { coins: 0, rows: 0, failed: 0 };
  return out;
}

/** Visible for tests: forgets everything. */
export function resetCurveCandles(): void {
  if (timer) clearInterval(timer);
  timer = null;
  cfg = null;
  flushing = null;
  flushed.clear();
  lastWritten.clear();
  dropped = [];
  lastSolUsd = null;
  stats = { coins: 0, rows: 0, failed: 0 };
}
