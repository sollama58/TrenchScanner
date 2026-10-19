import {
  prisma,
  createLogger,
  PumpFunClient,
  pumpFunCursorBefore,
  type PumpFunTradesPage,
} from "@trenchscanner/core";
import { flaggedRows, prismaFlaggedTradeStore, type FlaggedTradeStore } from "./chartFlaggedTrades.js";

const logger = createLogger("chart-mark-fill");

/**
 * Keeps and fills in a coin's chart marks (user ask 2026-10-19: keep them 30 days, 14 more each
 * time the coin is opened again, and reload them for older and looked-up coins, the middle
 * included). The saved flagged trades (ChartFlaggedTrade) are only those the live trades follower
 * saw while someone had the coin open, so a coin's marks had a hole from the trade tape's end (30
 * minutes past the call) to the first time its page was open, and again for every stretch nobody
 * watched; a looked-up coin with no tape had none before it was opened.
 *
 * Opening a coin's chart now:
 *  - keeps its marks KEEP_AFTER_OPEN_DAYS from now (ChartMarkCoin.keepUntil; the nightly cleanup
 *    spares them past TWA_RETENTION_DAYS until then), and
 *  - queues a fill: its trades from the tape's end (the launch, without a tape) to now are read
 *    from Pump.fun's trade API, newest first, and its flagged wallets' trades saved as the live
 *    follower saves them. Free (no Helius credit), at FILL_PAGES_PER_MINUTE of the swap host's 240,
 *    PAGES_PER_FILL pages (3,000 trades) an open at most. ChartMarkCoin.filledFrom..filledTo is
 *    the span read so far, so an open reads only what is new since the last one, then works back
 *    toward the start on later opens. A coin Pump.fun doesn't have is marked read and left.
 * Both happen once an hour per coin and process at most; the queue is one coin at a time.
 */

/** A coin's marks are kept this long after its chart was last opened. */
export const KEEP_AFTER_OPEN_DAYS = 14;
const DAY_MS = 24 * 3_600_000;
/** A coin's open counts (keep and fill) at most this often per process. */
const OPEN_EVERY_MS = 3_600_000;
/** Coins whose last open is remembered; past it the oldest is forgotten (and may count again). */
const MAX_REMEMBERED = 5_000;
/** A fill read up to this close to now counts as current. */
export const FRESH_MS = 10 * 60_000;
/** Pump.fun pages (100 trades each) one fill reads at most. */
export const PAGES_PER_FILL = 30;
/** The fills' share of the swap host's budget (pumpfunGate.ts: 240 a minute). */
const FILL_PAGES_PER_MINUTE = 20;
/** One API instance fills a coin at a time; a crashed one's claim lapses after this. */
const LEASE_MS = 5 * 60_000;
/** Coins waiting for a fill at most; past it new opens wait for their next hour. */
const MAX_QUEUED = 50;

/** The span a coin's fill has read, unbroken (ms epoch); nulls before any read. */
export interface FillSpan {
  from: number | null;
  to: number | null;
}

/** One fill's read: newest first from `cursorAt` down to `stopAt`. */
export interface FillPlan {
  /** "first": nothing read yet. "newer": what came since the last read. "older": back toward the start. */
  kind: "first" | "newer" | "older";
  cursorAt: number;
  stopAt: number;
}

/** Exported for tests. The next read for a coin whose marks start at `startMs`, or null when it is current. */
export function planFill(startMs: number, span: FillSpan, now: number): FillPlan | null {
  if (span.from === null || span.to === null) return { kind: "first", cursorAt: now, stopAt: startMs };
  if (now - span.to > FRESH_MS) return { kind: "newer", cursorAt: now, stopAt: span.to };
  if (span.from > startMs) return { kind: "older", cursorAt: span.from, stopAt: startMs };
  return null;
}

/**
 * Exported for tests. The span read after `plan` reached back to `reachedAt` (its stopAt when it
 * got there). A newer read that stopped short leaves a hole above the old span, which is let go:
 * the older reads then go over it again, and the saves skip what is already there.
 */
export function spanAfter(plan: FillPlan, span: FillSpan, reachedAt: number): FillSpan {
  if (plan.kind === "first") return { from: reachedAt, to: plan.cursorAt };
  if (plan.kind === "newer")
    return reachedAt <= plan.stopAt
      ? { from: span.from, to: plan.cursorAt }
      : { from: reachedAt, to: plan.cursorAt };
  return { from: reachedAt, to: span.to };
}

export interface MarkFillStore {
  /** Keeps the coin's marks until `until` at least. */
  keep(mint: string, until: Date): Promise<void>;
  /** Claims the coin's fill until `leaseUntil`: its span, or null while another instance has it. */
  claim(mint: string, now: Date, leaseUntil: Date): Promise<FillSpan | null>;
  /** Sets the span read and lets the claim go. */
  release(mint: string, span: FillSpan, calls: number): Promise<void>;
}

/** One page of the coin's trades older than `cursor`, newest first; null when Pump.fun has no such coin. */
export type TradePages = (mint: string, cursor: string) => Promise<PumpFunTradesPage | null>;

interface Job {
  mint: string;
  startMs: number;
  onFilled: () => void;
}

export class ChartMarkFiller {
  private readonly opened = new Map<string, number>();
  private readonly queue: Job[] = [];
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: MarkFillStore,
    private readonly flags: FlaggedTradeStore,
    private readonly pages: TradePages,
    private readonly opts: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * A coin's chart was opened: keep its marks and fill them in from `startMs` (the tape's end, or
   * the launch). `onFilled` runs after a fill saved anything, for the chart's cached marks.
   */
  open(mint: string, startMs: number, onFilled: () => void = () => {}): void {
    if (this.stopped) return;
    const now = this.now();
    const last = this.opened.get(mint);
    if (last !== undefined && now - last < OPEN_EVERY_MS) return;
    this.opened.delete(mint);
    this.opened.set(mint, now);
    if (this.opened.size > MAX_REMEMBERED) this.opened.delete(this.opened.keys().next().value!);
    // The fill claims the row the keep writes, so it is queued once the keep is in.
    void this.store.keep(mint, new Date(now + KEEP_AFTER_OPEN_DAYS * DAY_MS)).then(
      () => {
        if (this.stopped || this.queue.length >= MAX_QUEUED || this.queue.some((j) => j.mint === mint))
          return;
        this.queue.push({ mint, startMs, onFilled });
        void this.drain();
      },
      (err: unknown) => logger.warn("chart marks keep failed", { mint, error: String(err) }),
    );
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Visible for tests: works the queue, one coin at a time. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job && !this.stopped; job = this.queue.shift()) {
        const saved = await this.fill(job.mint, job.startMs).catch((err: unknown) => {
          logger.warn("chart marks fill failed", { mint: job!.mint, error: String(err) });
          return 0;
        });
        if (saved > 0) job.onFilled();
      }
    } finally {
      this.running = false;
    }
  }

  /** Visible for tests: one fill of one coin; the flagged trades saved. */
  async fill(mint: string, startMs: number): Promise<number> {
    const now = this.now();
    const span = await this.store.claim(mint, new Date(now), new Date(now + LEASE_MS));
    if (!span) return 0;
    let next = span;
    let calls = 0;
    let saved = 0;
    try {
      const plan = planFill(startMs, span, now);
      if (!plan) return 0;
      const trades: { sig: string; wallet: string; side: "buy" | "sell"; sol: number; atMs: number }[] = [];
      // +1: the trades at the span's own millisecond are read again rather than missed.
      let cursor = pumpFunCursorBefore(plan.cursorAt + 1);
      let reachedAt = plan.cursorAt;
      let done = false;
      while (calls < PAGES_PER_FILL && !this.stopped) {
        if (calls > 0) await (this.opts.sleep ?? sleep)(60_000 / FILL_PAGES_PER_MINUTE);
        let page: PumpFunTradesPage | null;
        try {
          page = await this.pages(mint, cursor);
        } catch (err) {
          // A 429 (ours or Pump.fun's) or a timeout: what was read is kept, the rest waits.
          logger.debug("chart marks page failed", { mint, error: String(err) });
          break;
        }
        calls += 1;
        if (!page) {
          // Not a Pump.fun coin: nothing to read, now or later.
          done = true;
          break;
        }
        for (const t of page.trades) {
          if (t.atMs < plan.stopAt || t.atMs > plan.cursorAt || !t.tx) continue;
          trades.push({ sig: t.tx, wallet: t.wallet, side: t.side, sol: t.sol, atMs: t.atMs });
        }
        const oldest = page.trades.reduce((m, t) => Math.min(m, t.atMs), Number.POSITIVE_INFINITY);
        if (oldest < reachedAt) reachedAt = oldest;
        if (!page.nextCursor || oldest < plan.stopAt) {
          done = true;
          break;
        }
        cursor = page.nextCursor;
      }
      if (trades.length > 0) {
        const { wallets, creators } = await this.flags.flagged(
          [...new Set(trades.map((t) => t.wallet))],
          [mint],
        );
        const rows = flaggedRows(new Map([[mint, trades]]), wallets, creators);
        if (rows.length > 0) await this.flags.save(rows);
        saved = rows.length;
      }
      // Nothing read (the first page failed): the span stays as it was.
      if (done || reachedAt < plan.cursorAt) next = spanAfter(plan, span, done ? plan.stopAt : reachedAt);
      return saved;
    } finally {
      await this.store
        .release(mint, next, calls)
        .catch((err: unknown) => logger.warn("chart marks release failed", { mint, error: String(err) }));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

const toDate = (ms: number | null) => (ms === null ? null : new Date(ms));

/** ChartMarkCoin, in the database. */
export const prismaMarkFillStore: MarkFillStore = {
  async keep(mint, until) {
    await prisma.chartMarkCoin.upsert({
      where: { mint },
      create: { mint, keepUntil: until },
      update: { keepUntil: until },
    });
  },
  async claim(mint, now, leaseUntil) {
    const { count } = await prisma.chartMarkCoin.updateMany({
      where: { mint, OR: [{ fillLeaseUntil: null }, { fillLeaseUntil: { lt: now } }] },
      data: { fillLeaseUntil: leaseUntil },
    });
    if (count === 0) return null;
    const row = await prisma.chartMarkCoin.findUnique({
      where: { mint },
      select: { filledFrom: true, filledTo: true },
    });
    return { from: row?.filledFrom?.getTime() ?? null, to: row?.filledTo?.getTime() ?? null };
  },
  async release(mint, span, calls) {
    await prisma.chartMarkCoin.updateMany({
      where: { mint },
      data: {
        filledFrom: toDate(span.from),
        filledTo: toDate(span.to),
        fillLeaseUntil: null,
        fillCalls: { increment: calls },
      },
    });
  },
};

let filler: ChartMarkFiller | null = null;

/** The process's filler, once the server listens (a test server fills nothing). */
export function setChartMarkFiller(f: ChartMarkFiller | null): void {
  filler?.stop();
  filler = f;
}

/** A coin's chart was opened (routes/tokens.ts readTokenChart). */
export function chartOpened(mint: string, startMs: number, onFilled?: () => void): void {
  filler?.open(mint, startMs, onFilled);
}

/** The production filler: Pump.fun's trade API on the process's swap-host budget. */
export function defaultChartMarkFiller(): ChartMarkFiller {
  const pumpFun = new PumpFunClient();
  return new ChartMarkFiller(prismaMarkFillStore, prismaFlaggedTradeStore, (mint, cursor) =>
    pumpFun.coinTrades(mint, cursor),
  );
}
