import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The closed-candle store's rows (CandleChunk, charts audit 2026-10-22 CH-8, user decision "Store
 * candles + backfill"): up to CANDLE_CHUNK_BARS consecutive bars of one width from one source,
 * packed into one row. Prices are USD market cap on Pump.fun's launch billion, as Pump.fun's
 * candles are; the API puts them on the supply now when it serves them. Pure: no database here.
 */

/** One stored bar: its start (ms), o/h/l/c (USD market cap) and USD volume (null: not known). */
export interface StoredBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number | null;
}

/** Bar widths the store holds, in seconds. */
export const CANDLE_RESOLUTIONS = [1, 15, 60, 300] as const;
export type CandleRes = (typeof CANDLE_RESOLUTIONS)[number];

/**
 * Where stored bars came from: the worker's curve tape on the bonding curve ("curve") and, after
 * graduation, on the coin's PumpSwap pool ("pool"), Pump.fun's pages, or GeckoTerminal's.
 */
export type CandleStoreSource = "curve" | "pool" | "pumpfun" | "gecko";

/** Bars per chunk: a minute of 1 s bars, 15 minutes of 15 s, an hour of 1 m, five hours of 5 m. */
export const CANDLE_CHUNK_BARS = 60;

/** Bars at or under this width (seconds) are the fine ones, kept CANDLE_FINE_RETENTION_DAYS. */
export const FINE_CANDLE_MAX_RES = 15;

/** One chunk as written and read: `startAt`, `coverFrom` and `coverTo` in ms. */
export interface CandleChunkRow {
  mint: string;
  res: CandleRes;
  startAt: number;
  source: CandleStoreSource;
  /**
   * The stretch the source covered without a break, [coverFrom, coverTo): inside the chunk, except
   * that the curve tape runs its last chunk's cover on over the quiet minutes after it (up to half
   * an hour; readCandleChunks reaches back five hours).
   */
  coverFrom: number;
  coverTo: number;
  /** Oldest first, each starting inside the chunk on a multiple of `res`. */
  bars: StoredBar[];
  /** Wider than a minute: a stand-in where no minute source reaches. */
  coarse: boolean;
}

/** A chunk's span in ms. */
export function chunkSpanMs(res: number): number {
  return res * 1_000 * CANDLE_CHUNK_BARS;
}

/** The start (ms) of the chunk holding `t`. */
export function chunkStartOf(t: number, res: number): number {
  const span = chunkSpanMs(res);
  return Math.floor(t / span) * span;
}

/** Whether a bar can be drawn: finite, positive prices; volume finite and non-negative or null. */
export function isDrawableBar(b: StoredBar): boolean {
  return (
    [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) &&
    Math.min(b.o, b.h, b.l, b.c) > 0 &&
    (b.vol === null || (Number.isFinite(b.vol) && b.vol >= 0))
  );
}

/** Bytes a bar takes before compression: its slot, four prices over the base and the volume. */
const BAR_BYTES = 1 + 4 * 4 + 4;

/**
 * Packs a chunk's bars as a float64 base price (the first open), then per bar a uint8 slot in the
 * chunk, o/h/l/c as float32 over the base and the volume as float32 (NaN for null), gzipped.
 * Float32 keeps about seven digits, plenty for a chart.
 */
export function packBars(bars: readonly StoredBar[], startAt: number, res: number): Buffer {
  const base = bars[0]?.o ?? 1;
  const buf = Buffer.alloc(8 + bars.length * BAR_BYTES);
  buf.writeDoubleLE(base, 0);
  bars.forEach((b, i) => {
    const o = 8 + i * BAR_BYTES;
    buf.writeUInt8(Math.round((b.t - startAt) / (res * 1_000)), o);
    buf.writeFloatLE(b.o / base, o + 1);
    buf.writeFloatLE(b.h / base, o + 5);
    buf.writeFloatLE(b.l / base, o + 9);
    buf.writeFloatLE(b.c / base, o + 13);
    buf.writeFloatLE(b.vol === null ? Number.NaN : b.vol, o + 17);
  });
  return gzipSync(buf, { level: 6 });
}

/** The reverse of packBars (prices back to absolute, to float32 precision). */
export function unpackBars(data: Uint8Array, startAt: number, res: number): StoredBar[] {
  const buf = gunzipSync(data);
  if (buf.length < 8) return [];
  const base = buf.readDoubleLE(0);
  const out: StoredBar[] = [];
  for (let o = 8; o + BAR_BYTES <= buf.length; o += BAR_BYTES) {
    const vol = buf.readFloatLE(o + 17);
    out.push({
      t: startAt + buf.readUInt8(o) * res * 1_000,
      o: buf.readFloatLE(o + 1) * base,
      h: buf.readFloatLE(o + 5) * base,
      l: buf.readFloatLE(o + 9) * base,
      c: buf.readFloatLE(o + 13) * base,
      vol: Number.isNaN(vol) ? null : vol,
    });
  }
  return out;
}

/**
 * Splits one source's bars of one width, read as covering [cover.from, cover.to) without a break,
 * into chunk rows. Bars off the width's grid or outside the cover are left out, and so are chunks
 * with no bar (a quiet stretch costs no row). `onlyClosed`: only chunks that end by `now`.
 */
export function chunkBars(
  mint: string,
  res: CandleRes,
  source: CandleStoreSource,
  bars: readonly StoredBar[],
  cover: { from: number; to: number },
  opts: { onlyClosed?: boolean; now?: number } = {},
): CandleChunkRow[] {
  const step = res * 1_000;
  const span = chunkSpanMs(res);
  const byChunk = new Map<number, StoredBar[]>();
  for (const b of bars) {
    if (b.t % step !== 0 || b.t + step <= cover.from || b.t >= cover.to || !isDrawableBar(b)) continue;
    const start = chunkStartOf(b.t, res);
    const list = byChunk.get(start);
    if (list) list.push(b);
    else byChunk.set(start, [b]);
  }
  const out: CandleChunkRow[] = [];
  for (const [start, list] of [...byChunk].sort((a, b) => a[0] - b[0])) {
    if (opts.onlyClosed && start + span > (opts.now ?? Date.now())) continue;
    // One bar per slot, the last given winning.
    const slots = new Map(list.map((b) => [b.t, b]));
    out.push({
      mint,
      res,
      startAt: start,
      source,
      coverFrom: Math.max(start, Math.min(cover.from, ...slots.keys())),
      coverTo: Math.min(start + span, cover.to),
      bars: [...slots.values()].sort((a, b) => a.t - b.t),
      coarse: res > 60,
    });
  }
  return out;
}

/**
 * Two readings of one chunk (same mint, width, start and source) as one: every bar of either, the
 * newer reading's winning a slot both hold. The covers join when they touch or overlap; apart, the
 * wider one stands (bars outside it are still real trades).
 */
export function mergeChunks(older: CandleChunkRow, newer: CandleChunkRow): CandleChunkRow {
  const slots = new Map(older.bars.map((b) => [b.t, b]));
  for (const b of newer.bars) slots.set(b.t, b);
  const touch = newer.coverFrom <= older.coverTo && older.coverFrom <= newer.coverTo;
  const wider = newer.coverTo - newer.coverFrom >= older.coverTo - older.coverFrom ? newer : older;
  return {
    ...newer,
    coverFrom: touch ? Math.min(older.coverFrom, newer.coverFrom) : wider.coverFrom,
    coverTo: touch ? Math.max(older.coverTo, newer.coverTo) : wider.coverTo,
    bars: [...slots.values()].sort((a, b) => a.t - b.t),
  };
}
