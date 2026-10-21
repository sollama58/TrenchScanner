import bs58 from "bs58";

/**
 * The price path of a young Pump.fun coin read off its bonding curve, change by change. The scan's
 * own tape (pricePath.ts) holds one price every 30 seconds and only from when the scan first
 * prices a coin, so on the two-minute-old coins most decisions are made on, its returns and
 * drawdowns are still waiting for tape (user ask 2026-10-17: the first ~15 minutes, as granular as
 * possible). The curve account changes on every trade, and its reserves are the price exactly:
 * the worker follows each young coin's curve on the Helius websocket (accountSubscribe) and reads
 * it by RPC where the stream doesn't reach (the worker's jobs/curveTape.ts). Pure, bounded, in
 * memory: nothing here is persisted, only the features it answers ride on the decision's row.
 *
 * The price is a step function: between two readings the curve did not change. So the price at
 * any moment the tape covers is exact, which is what lets a 10-second return mean 10 seconds.
 */

/** Anchor's discriminator for Pump.fun's BondingCurve account (same as pumpLaunch.ts). */
const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
/** The discriminator, five u64s and `complete`. */
const MIN_CURVE_LENGTH = 49;
/** Where the quote mint sits; all zeros, or absent on older curves, is SOL. */
const QUOTE_MINT_OFFSET = 83;
/** How many bytes of the account a reader needs: through the quote mint. */
export const CURVE_READ_BYTES = QUOTE_MINT_OFFSET + 32;

export interface CurveState {
  /** Virtual reserves: the price is virtualQuote / virtualToken (quote's base units per token base unit). */
  virtualToken: number;
  virtualQuote: number;
  /** Quote actually in the curve, in base units (lamports for SOL): its change is the net buying. */
  realQuote: number;
  /** The curve has graduated: it trades no more. */
  complete: boolean;
  /** Quoted in SOL (most launches); a coin-quoted curve's realQuote is not SOL. */
  quoteIsSol: boolean;
  /** What a coin-quoted curve is paired with (USD1, a tokenized stock, ...); null for SOL. */
  quoteMint?: string | null;
}

function u64(data: Uint8Array, offset: number): number {
  return Number(new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true));
}

/**
 * A curve account's data (raw bytes or base64), or null when it isn't a BondingCurve. A graduated
 * curve is emptied at migration: it reads as complete with zero reserves, which price nothing
 * (`virtualToken` 0), so a reader of prices checks `complete` (or the reserves) before dividing.
 */
export function decodeCurve(raw: Uint8Array | string): CurveState | null {
  const data = typeof raw === "string" ? Uint8Array.from(Buffer.from(raw, "base64")) : raw;
  if (data.length < MIN_CURVE_LENGTH || BONDING_CURVE_DISCRIMINATOR.some((b, i) => data[i] !== b))
    return null;
  const virtualToken = u64(data, 8);
  const virtualQuote = u64(data, 16);
  const complete = data[48] === 1;
  if (!complete && (!(virtualToken > 0) || !(virtualQuote > 0))) return null;
  const quote = data.subarray(QUOTE_MINT_OFFSET, QUOTE_MINT_OFFSET + 32);
  const quoteIsSol = quote.length < 32 || quote.every((b) => b === 0);
  return {
    virtualToken,
    virtualQuote,
    realQuote: u64(data, 32),
    complete,
    quoteIsSol,
    quoteMint: quoteIsSol ? null : bs58.encode(quote),
  };
}

export interface CurvePathFeatures {
  /** Seconds of unbroken tape behind the newest reading (capped at the tape's span). */
  curveCoveredSec: number | null;
  /** Price change over the last 10 s / 30 s / 1 / 3 / 5 minutes, in percent; null past the tape. */
  curveRet10sPct: number | null;
  curveRet30sPct: number | null;
  curveRet1mPct: number | null;
  curveRet3mPct: number | null;
  curveRet5mPct: number | null;
  /** Price against the highest / lowest of the covered tape, in percent (<= 0 / >= 0). */
  curveFromHighPct: number | null;
  curveFromLowPct: number | null;
  /** Seconds since that high. */
  curveSecSinceHigh: number | null;
  /** SOL that went into the curve, net of what came out, over the last 30 s / 1 / 3 minutes. */
  curveNetSol30s: number | null;
  curveNetSol1m: number | null;
  curveNetSol3m: number | null;
  /** Curve changes (roughly, trading slots) in the last minute; only on a minute the stream covered. */
  curveChanges1m: number | null;
  /** Standard deviation of the 5-second returns over the last minute, in percent. */
  curveVolatility1m: number | null;
}

export const EMPTY_CURVE_PATH: CurvePathFeatures = {
  curveCoveredSec: null,
  curveRet10sPct: null,
  curveRet30sPct: null,
  curveRet1mPct: null,
  curveRet3mPct: null,
  curveRet5mPct: null,
  curveFromHighPct: null,
  curveFromLowPct: null,
  curveSecSinceHigh: null,
  curveNetSol30s: null,
  curveNetSol1m: null,
  curveNetSol3m: null,
  curveChanges1m: null,
  curveVolatility1m: null,
};

/** Where a reading came from: the stream (every change), or an RPC read (a seed or a poll). */
export type CurveSource = "stream" | "read";

interface Tick {
  at: number;
  price: number;
  realQuote: number;
}

interface Tape {
  ticks: Tick[];
  /** Covered without a break from here (ms epoch). */
  coveredFrom: number;
  /** The last moment the state was known current: a reading, or the stream confirming it is live. */
  confirmedAt: number;
  /** Every change since here came from the stream (null: a read since, or never streamed). */
  streamFrom: number | null;
  quoteIsSol: boolean;
  complete: boolean;
}

/** How long a mint's tape reaches back: the longest window the features look at, plus slack. */
const TAPE_MS = 16 * 60_000;
/** Readings kept per mint at most (a busy curve changes a few times a second). */
const MAX_TICKS = 2_500;
/** Mints followed at most; the least recently read are dropped past it. */
const MAX_MINTS = 2_000;
/**
 * Unconfirmed for longer than this, the tape has a hole: what happened in it is unknown, so the
 * cover starts again. Three missed 5-second read rounds.
 */
export const CURVE_GAP_MS = 15_000;
const SECOND = 1_000;

export class CurveTape {
  private readonly tapes = new Map<string, Tape>();
  private readonly keepMs: number;
  private readonly maxTicks: number;

  /**
   * `keepMs` / `maxTicks`: how far back and how many changes a mint's tape keeps (the features
   * still read at most TAPE_MS of it). Longer for the worker's price path recorder, which saves the
   * whole tape when a coin is let go.
   */
  constructor(opts: { keepMs?: number; maxTicks?: number } = {}) {
    this.keepMs = Math.max(TAPE_MS, opts.keepMs ?? TAPE_MS);
    this.maxTicks = Math.max(MAX_TICKS, opts.maxTicks ?? MAX_TICKS);
  }

  get size(): number {
    return this.tapes.size;
  }

  /** The newest reading's time for a mint (ms epoch), or null with none. */
  lastAt(mint: string): number | null {
    const t = this.tapes.get(mint);
    return t ? (t.ticks[t.ticks.length - 1]?.at ?? null) : null;
  }

  /** Whether the curve was seen graduated. */
  isComplete(mint: string): boolean {
    return this.tapes.get(mint)?.complete ?? false;
  }

  /**
   * One reading of a mint's curve at `at`. A reading older than the newest is ignored (a read that
   * was in flight while the stream delivered a later change). An RPC read opens the cover (or
   * keeps it, when the tape was confirmed recently) and breaks the stream's run.
   */
  record(mint: string, at: number, state: CurveState, source: CurveSource): void {
    let tape = this.tapes.get(mint);
    // Emptied at graduation: no price, only that it is over.
    if (!(state.virtualToken > 0) || !(state.virtualQuote > 0)) {
      if (tape) tape.complete = true;
      return;
    }
    const price = state.virtualQuote / state.virtualToken;
    if (!tape) {
      // The stream only speaks on a change, and the change it reports is the state after it: what
      // the curve was before it is unknown, so a stream reading can't open a tape.
      if (source === "stream") return;
      if (this.tapes.size >= MAX_MINTS) this.evictOldest();
      tape = {
        ticks: [],
        coveredFrom: at,
        confirmedAt: at,
        streamFrom: null,
        quoteIsSol: state.quoteIsSol,
        complete: false,
      };
    } else {
      this.tapes.delete(mint);
      const last = tape.ticks[tape.ticks.length - 1];
      if (last && at < last.at) {
        this.tapes.set(mint, tape);
        return;
      }
      if (at - tape.confirmedAt > CURVE_GAP_MS) {
        // A reading after a hole: the price is known from here, the move into it is not.
        tape.ticks = [];
        tape.coveredFrom = at;
        tape.streamFrom = null;
      }
    }
    tape.confirmedAt = Math.max(tape.confirmedAt, at);
    tape.complete ||= state.complete;
    if (source === "read") tape.streamFrom = null;
    const last = tape.ticks[tape.ticks.length - 1];
    if (!last || last.price !== price || last.realQuote !== state.realQuote) {
      tape.ticks.push({ at, price, realQuote: state.realQuote });
    }
    const cutoff = at - this.keepMs;
    let drop = 0;
    // Keep the newest tick at or before the cutoff: it is the price through the cutoff.
    while (drop + 1 < tape.ticks.length && tape.ticks[drop + 1]!.at <= cutoff) drop += 1;
    if (tape.ticks.length - drop > this.maxTicks) drop = tape.ticks.length - this.maxTicks;
    if (drop > 0) tape.ticks.splice(0, drop);
    tape.coveredFrom = Math.max(tape.coveredFrom, tape.ticks[0]!.at, cutoff);
    this.tapes.set(mint, tape);
  }

  /**
   * The stream says it has followed `mint`'s curve without a break since `since`: every change in
   * that span was delivered, so the state is known current at `at`. Starts the stream's run when
   * the tape was already current at `since`.
   */
  confirmStreamed(mint: string, since: number, at: number): void {
    const tape = this.tapes.get(mint);
    if (!tape || at - tape.confirmedAt > CURVE_GAP_MS) return;
    if (since > tape.confirmedAt) return;
    tape.confirmedAt = Math.max(tape.confirmedAt, at);
    tape.streamFrom ??= Math.max(since, tape.coveredFrom);
  }

  /** The path features as of `now`; all null when the tape is not current. */
  features(mint: string, now: number): CurvePathFeatures {
    const tape = this.tapes.get(mint);
    if (!tape || tape.ticks.length === 0 || now - tape.confirmedAt > CURVE_GAP_MS)
      return { ...EMPTY_CURVE_PATH };
    const ticks = tape.ticks;
    const from = Math.max(tape.coveredFrom, now - TAPE_MS);
    const current = ticks[ticks.length - 1]!;
    /** The reading in force at `t`: the newest at or before it. */
    const at = (t: number): Tick | null => {
      if (t < from) return null;
      let lo = 0;
      let hi = ticks.length - 1;
      let found: Tick | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ticks[mid]!.at <= t) {
          found = ticks[mid]!;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found;
    };
    const ret = (sec: number): number | null => {
      const then = at(now - sec * SECOND);
      return then ? ((current.price - then.price) / then.price) * 100 : null;
    };
    const netSol = (sec: number): number | null => {
      if (!tape.quoteIsSol) return null;
      const then = at(now - sec * SECOND);
      return then ? round((current.realQuote - then.realQuote) / 1e9, 3) : null;
    };
    let high = -Infinity;
    let highAt = now;
    let low = Infinity;
    const base = at(from);
    for (const t of ticks) {
      if (t.at < from && t !== base) continue;
      if (t.price > high) {
        high = t.price;
        highAt = Math.max(t.at, from);
      }
      if (t.price < low) low = t.price;
    }
    let changes: number | null = null;
    if (tape.streamFrom !== null && tape.streamFrom <= now - 60 * SECOND) {
      changes = 0;
      for (let i = ticks.length - 1; i >= 0 && ticks[i]!.at > now - 60 * SECOND; i--) changes += 1;
    }
    let volatility: number | null = null;
    if (from <= now - 60 * SECOND) {
      const rets: number[] = [];
      for (let k = 12; k >= 1; k--) {
        const a = at(now - k * 5 * SECOND);
        const b = at(now - (k - 1) * 5 * SECOND);
        if (a && b) rets.push(Math.log(b.price / a.price));
      }
      if (rets.length === 12) {
        const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
        volatility = round(Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length) * 100, 3);
      }
    }
    return {
      curveCoveredSec: Math.round((now - from) / SECOND),
      curveRet10sPct: roundOrNull(ret(10)),
      curveRet30sPct: roundOrNull(ret(30)),
      curveRet1mPct: roundOrNull(ret(60)),
      curveRet3mPct: roundOrNull(ret(180)),
      curveRet5mPct: roundOrNull(ret(300)),
      curveFromHighPct: round(((current.price - high) / high) * 100),
      curveFromLowPct: round(((current.price - low) / low) * 100),
      curveSecSinceHigh: Math.round((now - highAt) / SECOND),
      curveNetSol30s: netSol(30),
      curveNetSol1m: netSol(60),
      curveNetSol3m: netSol(180),
      curveChanges1m: changes,
      curveVolatility1m: volatility,
    };
  }

  /**
   * The curve's price now (lamports per raw token unit), or null when the tape is not current or
   * the curve is not priced in SOL (one SOL-wide conversion to dollars covers the rest).
   */
  priceNow(mint: string, now: number): number | null {
    const tape = this.tapes.get(mint);
    if (!tape || tape.complete || !tape.quoteIsSol || now - tape.confirmedAt > CURVE_GAP_MS) return null;
    return tape.ticks[tape.ticks.length - 1]?.price ?? null;
  }

  /**
   * Curve prices the outcome label can fold in between `afterMs` and `untilMs` (both ms epoch).
   * `basis` is the price in force at `afterMs` when this cover includes that moment. `changes`
   * are prints with `at` in (`afterMs`, `untilMs`], oldest first. Empty when the mint has no
   * tape, or the cover ends before the window: a hole already dropped the unknown stretch, and
   * nothing here invents a price across it. In memory only; the watcher reads it in process.
   */
  labelPrices(
    mint: string,
    afterMs: number,
    untilMs: number,
  ): { basis: { at: number; price: number } | null; changes: { at: number; price: number }[] } {
    const empty = { basis: null, changes: [] as { at: number; price: number }[] };
    const tape = this.tapes.get(mint);
    if (!tape || tape.ticks.length === 0 || !(untilMs > afterMs)) return empty;
    if (untilMs < tape.coveredFrom) return empty;
    const changes: { at: number; price: number }[] = [];
    let basis: { at: number; price: number } | null = null;
    for (const tick of tape.ticks) {
      if (tick.at < tape.coveredFrom) continue;
      if (tick.at <= afterMs) basis = { at: tick.at, price: tick.price };
      else if (tick.at <= untilMs) changes.push({ at: tick.at, price: tick.price });
      else break;
    }
    return { basis, changes };
  }

  /** Forgets a mint. */
  forget(mint: string): void {
    this.tapes.delete(mint);
  }

  /**
   * A mint's tape as it stands: every change it holds (price, real quote reserve) since coveredFrom,
   * oldest first, for the worker's price path recorder. Null when the mint has none.
   */
  snapshot(mint: string): {
    coveredFrom: number;
    quoteIsSol: boolean;
    ticks: { at: number; price: number; realQuote: number }[];
  } | null {
    const t = this.tapes.get(mint);
    if (!t || t.ticks.length === 0) return null;
    return { coveredFrom: t.coveredFrom, quoteIsSol: t.quoteIsSol, ticks: t.ticks.map((k) => ({ ...k })) };
  }

  private evictOldest(): void {
    const oldest = this.tapes.keys().next().value;
    if (oldest !== undefined) this.tapes.delete(oldest);
  }
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function roundOrNull(v: number | null): number | null {
  return v === null ? null : round(v);
}
