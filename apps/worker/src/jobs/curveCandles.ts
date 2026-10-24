import {
  chunkBars,
  chunkStartOf,
  runCoversOn,
  createLogger,
  CURVE_GAP_MS,
  saveCandleChunks,
  type CandleChunkRow,
  type CandleStoreSource,
  type CurveTape,
  type QuoteUsd,
  type StoredBar,
} from "@trenchscanner/core";

const logger = createLogger("curve-candles");

/**
 * The chart's own 1-second candles (charts audit 2026-10-22 target design, user decision "Store
 * candles + backfill"): the curve tape (curveTape.ts) already follows every tracked Pump.fun coin
 * from about its launch on the Helius stream, so its changes are folded into 1-second OHLC bars and
 * saved to the candle store (CandleChunk) every FLUSH_MS, one minute of a coin per row. No upstream
 * call and no Helius credit: it reads only what the tape holds. Volume is the SOL that moved through
 * the curve between changes (its real SOL reserve, out or in), at SOL's price at the flush.
 *
 * Only a stretch the stream delivered is saved: a tape read by RPC every few seconds would make
 * "1-second" bars of 5-second samples (charts audit CH-6). A curve quoted in another coin (DJT, ORE,
 * USD1...) is priced with that coin's USD price at the flush (quoteUsd), as the API's live chart
 * prices it: until 2026-10-24 it was left out, and such a coin had nothing of ours recorded but the
 * minutes of a chart left open (prod: 2TKD, a $2.6M runner quoted in DJT). After graduation the
 * tape follows the coin's PumpSwap pool, whose bars are saved the same way under "pool"
 * (curveTape.ts).
 */

/** Pump.fun's curve price is lamports per raw token unit: times this, SOL per whole token x one billion. */
const MCAP_SOL_PER_PRICE = 1e6;
/**
 * How often the tapes are saved. 20 s since 2026-10-24 (was a minute): the store is what a chart
 * reads for every second before its own live tail began, so what the worker holds and hasn't
 * written yet is a blank stretch right before the live edge on a 1-second chart, about as long as
 * this plus the write (chart audit 2026-10-24: 30-90 s on every freshly opened coin). The chunk a
 * coin's bars end in is rebuilt whole each flush, so the forming minute is written as it grows.
 */
export const FLUSH_MS = 20_000;
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
 * USD per unit of a curve's price and reserve, read as SOL's 9 decimals: SOL's price for a SOL
 * curve, a quote coin's scaled from its own decimals (as the API's live chart, liveCurve.ts usdRate).
 */
export function quoteUsdRate(q: QuoteUsd): number {
  return q.usd * 10 ** (9 - q.decimals);
}

/**
 * Exported for tests. 1-second market-cap bars (USD, on the launch billion) over [from, to) from a
 * curve's changes, oldest first. Each opens at the price in force when its second began (the last
 * change before it), so bars join up; a second with no change has no bar, as Pump.fun's candles
 * leave quiet intervals out, and the tape's first reading is where it starts, not a bar. Volume:
 * the quote reserve's moves inside the second, in USD. `usdRate`: SOL's USD price for a SOL curve,
 * else quoteUsdRate of its quote coin.
 */
export function curveBars(ticks: readonly Tick[], from: number, to: number, usdRate: number): StoredBar[] {
  const toMcap = (price: number) => price * MCAP_SOL_PER_PRICE * usdRate;
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
    bar.vol! += (Math.abs(k.realQuote - prev.realQuote) / 1e9) * usdRate;
    prev = k;
  }
  return out;
}

/**
 * How far a chunk's cover may run on over a quiet stretch after it, past its own start: the store
 * reads chunks starting up to five hours before the window it is asked for (core's
 * readCandleChunks), so a cover running on longer would not be found. Past it, the quiet stretch
 * goes on under a new row (curveCandleRows).
 */
export const QUIET_RUN_MAX_MS = 4 * 3_600_000;

/**
 * Exported for tests. A coin's chunk rows from what the tape holds after `flushedTo` (null: nothing
 * saved yet), up to `closeAt`, priced at `usdRate` (curveBars), and where the next flush picks up.
 * The chunk `flushedTo` is in is built again whole, so a minute saved in part is rewritten with all
 * its bars (the store keeps the fuller reading). Null when the tape is not on the stream (nothing
 * to vouch for) or nothing is priced.
 *
 * Minutes with no change have no bars, so no chunk of their own: the chunk the saved bars end in
 * vouches for them instead, its cover run on to the close (the store reads a chunk's cover past its
 * own minute), and the next flush picks up at that chunk, so a quiet minute reads as quiet, not as
 * a stretch nobody read (the chart draws those blank: GET /tokens/:mint/candles `holes`). A coin
 * with no change at all since the last flush gets the same: a row with no bar and only the cover,
 * which the store merges into the chunk's bars (core's saveCandleChunks). Until 2026-10-24 such a
 * flush wrote nothing and left the vouching to the coin's next trade, so a coin that went quiet
 * drew "No data recorded" from its last trade until someone opened its chart, and the browser's
 * GeckoTerminal fill then painted minute candles over the stretch (chart audit 2026-10-24: 11 of
 * the 30 latest called or matched coins). Past QUIET_RUN_MAX_MS of quiet the cover goes on under a
 * new row, so the store's read reaches it.
 */
export function curveCandleRows(
  mint: string,
  tape: TapeTicks,
  flushedTo: number | null,
  closeAt: number,
  usdRate: number,
  source: TapeSource = "curve",
): { rows: CandleChunkRow[]; flushedTo: number } | null {
  if (!tape || tape.streamFrom === null || !(usdRate > 0)) return null;
  const covered = Math.max(tape.coveredFrom, tape.streamFrom);
  const from = Math.max(covered, flushedTo === null ? covered : chunkStartOf(flushedTo, 1));
  const to = Math.floor(Math.min(closeAt, tape.confirmedAt) / 1_000) * 1_000;
  if (!(to > from)) return null;
  const ticks = tape.prior ? [tape.prior, ...tape.ticks] : tape.ticks;
  const bars = curveBars(ticks, from, to, usdRate);
  const rows = chunkBars(mint, 1, source, bars, { from, to });
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) {
    // No change at all over [from, to), which the stream delivered whole: quiet. The cover hangs on
    // the chunk the saved bars end in (or the stretch's own first chunk), as a row with no bar.
    let anchor = chunkStartOf(flushedTo ?? from, 1);
    let runTo = Math.min(to, anchor + QUIET_RUN_MAX_MS);
    if (runTo <= from) {
      // The anchor is too far back to reach this stretch: the stretch's own chunk carries it.
      anchor = chunkStartOf(from, 1);
      runTo = Math.min(to, anchor + QUIET_RUN_MAX_MS);
    }
    const quiet: CandleChunkRow = {
      mint,
      res: 1,
      startAt: anchor,
      source,
      coverFrom: from,
      coverTo: runTo,
      bars: [],
      coarse: false,
    };
    // The anchor stays while its cover may still run on; past the run, the next flush anchors at
    // where this cover ends, so the two covers touch.
    return { rows: [quiet], flushedTo: runTo < to ? runTo : Math.max(flushedTo ?? from, anchor) };
  }
  // The stream delivered every change since `from`: the stretch before the first bar, and each one
  // between two chunks, was quiet. A cover may start before its chunk and run on past it.
  if (first.coverFrom > from && first.startAt - from <= QUIET_RUN_MAX_MS) first.coverFrom = from;
  runCoversOn(rows.slice(0, -1), last.startAt, QUIET_RUN_MAX_MS);
  const runTo = Math.min(to, last.startAt + QUIET_RUN_MAX_MS);
  last.coverTo = Math.max(last.coverTo, runTo);
  // The next flush picks up at the last chunk, rebuilt whole with its cover run on further; or,
  // past the run, where the cover ends.
  return { rows, flushedTo: runTo < to ? runTo : last.startAt };
}

/** Where a coin's tape is read from: the start of the chunk its saved bars end in (all of it at first). */
function readAfter(flushedTo: number | null): number {
  return flushedTo === null ? -1 : chunkStartOf(flushedTo, 1) - 1;
}

interface WriterConfig {
  view: CurveTapeView;
  /** SOL's USD price; the flush waits for one (the tape keeps half an hour). */
  solUsd: () => Promise<number | null>;
  /**
   * A quote coin's USD price, for a curve quoted in another coin; absent, such a curve is left out.
   * A coin with no price waits for one, as a SOL curve waits for SOL's.
   */
  quoteUsd?: (quoteMint: string) => Promise<QuoteUsd | null>;
  save?: (rows: CandleChunkRow[]) => Promise<unknown>;
}

/** A quote coin's last price is used for at most this long while new reads fail. */
const QUOTE_MAX_AGE_MS = 10 * 60_000;
/** Quote coins whose last price is held at most. */
const MAX_QUOTES = 200;

let cfg: WriterConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
/** Per followed coin, where its saved bars end (ms). */
const flushed = new Map<string, number>();
/** Per followed coin, the last chunk written: rebuilt unchanged, it isn't written again. */
const lastWritten = new Map<string, { startAt: number; coverFrom: number; coverTo: number; bars: number }>();
/**
 * Whether a rebuilt chunk says nothing the last write of it didn't: the same bars, its cover within
 * the one written (a rebuild from the chunk's own start restates a cover that began before it).
 */
const sameRow = (
  a: CandleChunkRow,
  b: { startAt: number; coverFrom: number; coverTo: number; bars: number } | undefined,
) =>
  !!b &&
  a.startAt === b.startAt &&
  a.coverFrom >= b.coverFrom &&
  a.coverTo <= b.coverTo &&
  a.bars.length === b.bars;
/** The last bars of coins the tape let go of, written with the next flush. */
let dropped: CandleChunkRow[] = [];
let lastSolUsd: number | null = null;
/** Each quote coin's last price as a rate (quoteUsdRate), and when it was read. */
const lastQuoteRate = new Map<string, { rate: number; at: number }>();

/** The USD rate a tape is priced at: SOL's, or its quote coin's held within QUOTE_MAX_AGE_MS; null with none. */
function rateOf(tape: NonNullable<TapeTicks>, now: number): number | null {
  if (tape.quoteIsSol) return lastSolUsd;
  const q = tape.quoteMint ? lastQuoteRate.get(tape.quoteMint) : undefined;
  return q && now - q.at <= QUOTE_MAX_AGE_MS ? q.rate : null;
}
let stats = { coins: 0, rows: 0, failed: 0, unpriced: 0, writeMs: 0 };
/** When coins left unpriced were last logged: once in UNPRICED_LOG_EVERY_MS, not every flush. */
let unpricedLoggedAt = 0;
const UNPRICED_LOG_EVERY_MS = 5 * 60_000;

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
  const last = lastWritten.get(mint);
  flushed.delete(mint);
  lastWritten.delete(mint);
  if (!cfg) return;
  const held = tape.ticksAfter(mint, readAfter(done));
  const rate = held ? rateOf(held, now) : null;
  if (rate === null) return;
  // Let go of now: what it held is known through now, when the tape was current lately.
  const known = held && now - held.confirmedAt <= CURVE_GAP_MS ? { ...held, confirmedAt: now } : held;
  const out = curveCandleRows(mint, known, done, now, rate, source);
  if (!out) return;
  // The chunk picked up from, rebuilt as it was written: not written again.
  const fresh = out.rows.filter((r) => !sameRow(r, last));
  if (dropped.length + fresh.length <= MAX_DROPPED) dropped.push(...fresh);
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
    // Each quote coin of the coin-quoted curves followed, read once a flush.
    const quoteMints = new Set<string>();
    for (const { tape } of tapes)
      if (tape && !tape.quoteIsSol && tape.quoteMint) quoteMints.add(tape.quoteMint);
    if (config.quoteUsd && quoteMints.size > 0) {
      const read = config.quoteUsd;
      await Promise.all(
        [...quoteMints].map(async (quoteMint) => {
          const q = await read(quoteMint).catch(() => null);
          if (!q || !(q.usd > 0) || !Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 18)
            return;
          lastQuoteRate.delete(quoteMint);
          lastQuoteRate.set(quoteMint, { rate: quoteUsdRate(q), at: now });
          while (lastQuoteRate.size > MAX_QUOTES) lastQuoteRate.delete(lastQuoteRate.keys().next().value!);
        }),
      );
    }
    if (lastSolUsd === null && lastQuoteRate.size === 0) return;
    const closeAt = all ? Math.floor(now / 1_000) * 1_000 : Math.floor(now / FLUSH_MS) * FLUSH_MS;
    const rows: CandleChunkRow[] = dropped;
    dropped = [];
    const next = new Map<string, number>();
    const newest = new Map<string, CandleChunkRow>();
    // Coins followed on the tape but priced by nothing this flush: SOL's price missing, or their
    // quote coin's. Counted on the heartbeat and logged with the quote coins, so a coin left
    // unrecorded is seen (chart audit 2026-10-24: coins quoted in another pump coin were skipped
    // here for hours without a trace).
    let unpriced = 0;
    const unpricedQuotes = new Set<string>();
    for (const { mint, done, source, tape } of tapes) {
      const rate = tape ? rateOf(tape, now) : null;
      if (rate === null) {
        if (tape) {
          unpriced += 1;
          if (!tape.quoteIsSol) unpricedQuotes.add(tape.quoteMint ?? "unknown quote");
        }
        continue;
      }
      const out = curveCandleRows(mint, tape, done, closeAt, rate, source);
      if (!out) continue;
      // The chunk picked up from, rebuilt as it was written: not written again.
      const fresh = out.rows.filter((r) => !sameRow(r, lastWritten.get(mint)));
      rows.push(...fresh);
      next.set(mint, out.flushedTo);
      const last = out.rows[out.rows.length - 1];
      if (last) newest.set(mint, last);
    }
    stats.unpriced += unpriced;
    if (unpriced > 0 && now - unpricedLoggedAt >= UNPRICED_LOG_EVERY_MS) {
      unpricedLoggedAt = now;
      logger.warn("curve candles: coins followed but priced by nothing, not recorded", {
        coins: unpriced,
        solUsd: lastSolUsd,
        quoteMints: [...unpricedQuotes].slice(0, 10),
      });
    }
    if (rows.length === 0) {
      for (const [mint, to] of next) flushed.set(mint, to);
      return;
    }
    const writeStarted = Date.now();
    try {
      await (config.save ?? saveCandleChunks)(rows);
      // The slowest write since the last heartbeat: the store's lag behind the live edge is this
      // plus the flush interval.
      stats.writeMs = Math.max(stats.writeMs, Date.now() - writeStarted);
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
  stats = { coins: 0, rows: 0, failed: 0, unpriced: 0, writeMs: 0 };
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
  lastQuoteRate.clear();
  unpricedLoggedAt = 0;
  stats = { coins: 0, rows: 0, failed: 0, unpriced: 0, writeMs: 0 };
}
