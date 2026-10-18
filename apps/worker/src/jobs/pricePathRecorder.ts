import { gunzipSync, gzipSync } from "node:zlib";
import { createLogger, prisma } from "@trenchscanner/core";

const logger = createLogger("price-path-recorder");

/**
 * The price path recorder (user ask 2026-10-18: training data for predictive price pathing, kept
 * cheap until the model is good). When the curve tape (curveTape.ts) lets go of a young coin -
 * past its age limit, off the watchlist, or graduated - the path it holds is folded to one row per
 * second with a change and queued here; the queue is written in one insert a minute. No upstream
 * calls (the tape is already followed on the Helius stream), a few KB per coin compressed, at most
 * PRICE_PATH_RECORD_MAX_PER_DAY coins a UTC day, and the cleanup job deletes rows after
 * PRICE_PATH_RETENTION_DAYS. The scanner's own factors for the same coins (TokenSnapshot,
 * CandidateOutcome, the trade tape's per-wallet rows) are joined by mint at training time.
 */

/** Fewest seconds with a change for a path to be worth keeping. */
export const MIN_ACTIVE_SECONDS = 30;
/** Rows a flush writes at most; the rest wait for the next. */
const FLUSH_MAX = 200;
/** Paths waiting at most: past it the newest are dropped (a stalled database must not grow memory). */
const MAX_PENDING = 1_000;
const FLUSH_MS = 60_000;

/** One second of a path: its offset from the start, close price, net quote in (SOL) and changes. */
export interface PathSecond {
  sec: number;
  price: number;
  netSol: number;
  changes: number;
}

/**
 * A tape's changes folded to one row per second that had one: the last price in the second, the
 * net SOL into the curve over it (0 when the curve isn't SOL-quoted) and how many changes it had.
 */
export function foldSeconds(
  ticks: readonly { at: number; price: number; realQuote: number }[],
  quoteIsSol: boolean,
): { startAt: number; rows: PathSecond[] } {
  if (ticks.length === 0) return { startAt: 0, rows: [] };
  const startAt = Math.floor(ticks[0]!.at / 1_000) * 1_000;
  const rows: PathSecond[] = [];
  let prevQuote = ticks[0]!.realQuote;
  for (const k of ticks) {
    const sec = Math.floor((k.at - startAt) / 1_000);
    let row = rows[rows.length - 1];
    if (!row || row.sec !== sec) {
      row = { sec, price: k.price, netSol: 0, changes: 0 };
      rows.push(row);
    }
    row.price = k.price;
    row.changes += 1;
    if (quoteIsSol) row.netSol += (k.realQuote - prevQuote) / 1e9;
    prevQuote = k.realQuote;
  }
  // The first reading is the starting state, not a change into it.
  rows[0]!.changes -= 1;
  return { startAt, rows };
}

/**
 * Packs rows as: a float64 base price, then per row a uint32 second offset, a float32 price over
 * the base, a float32 net SOL and a uint16 change count (14 bytes), then gzips it.
 */
export function packPath(rows: readonly PathSecond[]): Buffer {
  const base = rows[0]?.price ?? 1;
  const buf = Buffer.alloc(8 + rows.length * 14);
  buf.writeDoubleLE(base, 0);
  rows.forEach((r, i) => {
    const o = 8 + i * 14;
    buf.writeUInt32LE(r.sec, o);
    buf.writeFloatLE(r.price / base, o + 4);
    buf.writeFloatLE(r.netSol, o + 8);
    buf.writeUInt16LE(Math.min(65_535, Math.max(0, r.changes)), o + 12);
  });
  return gzipSync(buf, { level: 9 });
}

/** The reverse of packPath (prices back to absolute, to float32 precision). */
export function unpackPath(data: Buffer): PathSecond[] {
  const buf = gunzipSync(data);
  const base = buf.readDoubleLE(0);
  const out: PathSecond[] = [];
  for (let o = 8; o + 14 <= buf.length; o += 14) {
    out.push({
      sec: buf.readUInt32LE(o),
      price: buf.readFloatLE(o + 4) * base,
      netSol: buf.readFloatLE(o + 8),
      changes: buf.readUInt16LE(o + 12),
    });
  }
  return out;
}

interface Pending {
  mint: string;
  startAt: Date;
  endAt: Date;
  seconds: number;
  bytes: number;
  reason: string;
  data: Buffer;
}

export interface RecorderConfig {
  maxPerDay: number;
}

type Writer = (rows: Pending[]) => Promise<unknown>;

let cfg: RecorderConfig | null = null;
let write: Writer = (rows) => prisma.pricePathRecord.createMany({ data: rows });
let pending: Pending[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let day = "";
let today = 0;
let stats = { recorded: 0, skipped: 0, capped: 0, written: 0, bytes: 0, failed: 0 };

/** Starts the recorder (the flush timer); returns its stop, which writes what is left. */
export function startPricePathRecorder(config: RecorderConfig, writer?: Writer) {
  cfg = config;
  if (writer) write = writer;
  timer = setInterval(() => void flushPricePaths(), FLUSH_MS);
  timer.unref?.();
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await flushPricePaths();
    cfg = null;
  };
}

/** The curve tape let go of `mint`: its path is queued when it is long enough and the day has room. */
export function recordPricePath(
  mint: string,
  snapshot: {
    quoteIsSol: boolean;
    ticks: readonly { at: number; price: number; realQuote: number }[];
  } | null,
  reason: "aged" | "graduated",
  now = Date.now(),
): void {
  if (!cfg || !snapshot) return;
  const d = new Date(now).toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    today = 0;
  }
  const { startAt, rows } = foldSeconds(snapshot.ticks, snapshot.quoteIsSol);
  if (rows.filter((r) => r.changes > 0).length < MIN_ACTIVE_SECONDS) {
    stats.skipped += 1;
    return;
  }
  // Paced through the UTC day (its share so far plus an hour's worth), so the cap doesn't fill with
  // the day's first hours.
  const share = (now - Date.parse(`${d}T00:00:00Z`)) / 86_400_000;
  if (today >= cfg.maxPerDay * Math.min(1, share + 1 / 24) || pending.length >= MAX_PENDING) {
    stats.capped += 1;
    return;
  }
  today += 1;
  const data = packPath(rows);
  pending.push({
    mint,
    startAt: new Date(startAt),
    endAt: new Date(startAt + rows[rows.length - 1]!.sec * 1_000),
    seconds: rows.length,
    bytes: data.length,
    reason,
    data,
  });
  stats.recorded += 1;
}

/** Writes up to FLUSH_MAX queued paths in one insert. A failure drops them (training data, not records). */
export async function flushPricePaths(): Promise<void> {
  if (flushing || pending.length === 0) return;
  flushing = true;
  const batch = pending.slice(0, FLUSH_MAX);
  pending = pending.slice(batch.length);
  try {
    await write(batch);
    stats.written += batch.length;
    stats.bytes += batch.reduce((s, r) => s + r.bytes, 0);
  } catch (err) {
    stats.failed += batch.length;
    logger.warn("price path write failed", { rows: batch.length, error: String(err) });
  } finally {
    flushing = false;
  }
}

/** Counts since the last call, for the scan's heartbeat; null while the recorder is off. */
export function takePricePathStats() {
  if (!cfg) return null;
  const out = { ...stats, pending: pending.length, today };
  stats = { recorded: 0, skipped: 0, capped: 0, written: 0, bytes: 0, failed: 0 };
  return out;
}

/** Visible for tests: forgets everything. */
export function resetPricePathRecorder(): void {
  if (timer) clearInterval(timer);
  timer = null;
  cfg = null;
  pending = [];
  flushing = false;
  day = "";
  today = 0;
  write = (rows) => prisma.pricePathRecord.createMany({ data: rows });
  stats = { recorded: 0, skipped: 0, capped: 0, written: 0, bytes: 0, failed: 0 };
}
