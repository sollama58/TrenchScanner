import {
  createLogger,
  decodeCurve,
  decodeLaunchLab,
  decodePoolVirtualQuote,
  decodeTokenAmount,
  HeliusAccountStream,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  type CurveState,
  type HeliusClient,
  launchSupplyFactors,
  type MintSupplySource,
  type PoolVaults,
  WRAPPED_SOL_MINT,
} from "@trenchscanner/core";
import type { QuotePrice, SolPrice } from "./solPrice.js";
import { chartHealth, type ChartHealth } from "./chartHealth.js";

const logger = createLogger("live-curve");

/**
 * The token chart's live tail (user ask 2026-10-17: charts on the stream's second-by-second
 * updates). The worker's curve tape follows every young coin's bonding curve, but in the worker's
 * memory, where the API can't read it. So while a chart is open on a Pump.fun coin still on its
 * curve, the API follows that one curve itself, on its own Helius websocket (accountSubscribe: an
 * update per changed block, ~0.5 KB at 2 credits per 0.1 MB), and the chart polls the changes
 * since its last answer. The curve's reserves are the price exactly, so the tail is every price
 * the coin traded at, to the block, without waiting on Pump.fun's candles.
 *
 * It never pauses on one source: a curve the stream doesn't cover (no stream, a dropped or refused
 * subscription) is read by RPC every READ_EVERY_MS instead, and SOL's price comes from three
 * providers (solPrice.ts). A curve nobody has asked about for IDLE_MS is let go, and the socket
 * closes once nothing is followed, so it costs nothing while no one is looking. Nothing is stored.
 *
 * Bonding doesn't end it (user ask 2026-10-18: charts went delayed after bonding): once a chart's
 * curve completes, the API follows the coin's PumpSwap pool instead, its two vaults on the same
 * socket (two subscriptions, ~0.4 KB an update each), read by RPC off the stream the same way.
 * Only for a chart's asks: the feed cards' quotes still let DexScreener price graduated coins.
 *
 * The stream is checked, not trusted (audit 2026-10-19, item 3: one account whose updates stopped
 * kept answering "stream" with a fresh readAt and a flat line). A covered curve or pool is re-read
 * by RPC every VERIFY_EVERY_MS; when the read differs from what the stream delivered and nothing
 * arrives within VERIFY_GRACE_MS to explain it, the cover is dropped (RPC reads it from the next
 * round), the read is recorded as a tick, and the stream resubscribes that key. `readAt` is the last
 * real delivery or matching check, never the ask's time. A socket silent for COVER_STALL_MS covers
 * nothing, so a stall falls back to RPC reads at once rather than after the reconnect's minute.
 *
 * Discovery (LaunchLab and CPMM pool scans, the PumpSwap pool lookup after bonding) runs in its own
 * loop with a time budget, so a slow program scan no longer holds the 5 s RPC reads or a chart's
 * seed read (audit item 10).
 */

/** A failed LaunchLab pool scan is tried again after this long. */
const LAUNCHLAB_RETRY_MS = 10_000;
/** Stonks coins' LaunchLab pools found so far (a scan each), kept across follows. */
const MAX_LAUNCHLAB_POOLS = 2_000;
/**
 * A graduated Stonks coin's CPMM pool scan (a getProgramAccounts, 10-20 credits) is tried again
 * after this long when it failed, not every READ_EVERY_MS; the vaults it finds are kept across
 * follows like the LaunchLab pools (audit 2026-10-19, H6).
 */
const CPMM_RETRY_MS = LAUNCHLAB_RETRY_MS;
/** A curve is let go once no chart has asked about it for this long. */
const IDLE_MS = 30_000;
/**
 * Off the stream, a followed curve is read this often (1 credit per 100 curves a read).
 * 5 seconds since 2026-10-22 (was 2). The stream path is unchanged: one read, then the socket.
 */
export const READ_EVERY_MS = 5_000;
/** How much of a curve's changes are kept: the First 15m view's span, with room. */
const KEEP_MS = 20 * 60_000;
const MAX_TICKS = 6_000;
/**
 * Curves followed at once; past it the least recently asked is let go. The feed cards' live tick
 * asks for its on-screen coins too (graduated ones hold a slot without costing anything).
 */
export const MAX_FOLLOWED = 400;
/**
 * Of those, the most the feed cards may hold (audit 2026-10-19, item 11: a busy board evicted open
 * charts, whose tails then started over from empty). A chart asked within IDLE_MS is pinned: a
 * card's follow never evicts it, and a card finding only pinned charts goes without (DexScreener
 * prices its card as before).
 */
export const MAX_CARD_FOLLOWED = 300;
/** A covered curve or pool is checked by RPC this often (1 credit per 100 accounts a check). */
export const VERIFY_EVERY_MS = 10_000;
/**
 * A check that differs from the stream waits this long for a delivery to explain it (the change
 * was in flight on the socket) before the cover counts as broken.
 */
export const VERIFY_GRACE_MS = 2_000;
/** Prices this close are the same price (the same integers read two ways). */
const SAME_PRICE = 1e-9;
/** The socket silent this long covers nothing (it speaks every ~0.4 s); the reconnect waits longer. */
export const COVER_STALL_MS = 20_000;
/** Discovery stops starting new scans after this long in one pass; the rest go next pass. */
const DISCOVERY_BUDGET_MS = 8_000;
/** The chart socket's counts are folded into the process totals (and chart health) this often. */
const DRAIN_EVERY_MS = 10_000;
/** The socket closes after nothing has been followed for this long. */
const SOCKET_IDLE_MS = 2 * 60_000;
/** An unconfirmed stretch longer than this is a hole: the cover starts again after it. */
const GAP_MS = 15_000;
const KEY_PREFIX = "chart:";
/** The stream keys of a followed pool's base and quote vaults. */
const POOL_BASE_PREFIX = "pool-base:";
const POOL_QUOTE_PREFIX = "pool-quote:";
/** The stream key of a followed PumpSwap pool's own account: its virtual quote reserve moves. */
const POOL_ACCOUNT_PREFIX = "pool-account:";
/**
 * A swap changes both vaults in one slot, delivered as two updates: the price is recorded once
 * both sides of a slot are in, or this long after one side came alone (a plain transfer in).
 */
const PAIR_WAIT_MS = 400;
/**
 * The longest a chart's ask with `waitMs` is held open for a new price change (user ask 2026-10-18:
 * the chart trailed by seconds when it only asked every couple of them).
 */
export const MAX_WAIT_MS = 8_000;
/** How long a chart's first ask waits on the seed read before answering "pending". */
const SEED_WAIT_MS = 2_500;

type Stream = Pick<HeliusAccountStream, "start" | "stop" | "watch" | "unwatch" | "coveredSince"> &
  Partial<Pick<HeliusAccountStream, "takeStats" | "resubscribe" | "stalledForMs" | "slotTime">>;

/** The chart socket's traffic since this process started, summed over every socket it opened. */
export interface LiveCurveStreamTotals {
  /** 1 while a chart socket is open, else 0. */
  connected: number;
  accountSubscriptions: number;
  accountUpdates: number;
  bytes: number;
  /** Estimated Helius credits (bytes received, plus one per connection opened). */
  credits: number;
  since: string;
}
export type CurveReader = Pick<HeliusClient, "getCurveStatesBatch"> &
  Partial<
    Pick<
      HeliusClient,
      "getPoolVaultsBatch" | "getTokenAmountsBatch" | "findLaunchLabPool" | "findCpmmPoolVaults"
    >
  >;

/** Where the newest prices came from. "pending": asked, not read yet. "none": not a live curve. */
export type LiveSource = "stream" | "rpc" | "pending" | "none";

/** GET /tokens/:mint/chart/live (web TokenChartCard's live tail). */
export interface LiveCurveAnswer {
  mint: string;
  source: LiveSource;
  /** What prices it now: the bonding curve, or after bonding the PumpSwap pool. */
  venue?: "curve" | "pool";
  /**
   * Nothing live prices the coin any more (no curve, or graduated with no SOL PumpSwap pool to
   * follow): the chart stops asking and reads candles.
   */
  complete: boolean;
  /** The ticks run without a break from here (ms), null with none. */
  coveredFrom: number | null;
  /** The newest moment the price is known current (ms): a change, a read, or the stream's word. */
  readAt: number | null;
  /** Each price change after `after`: [ms, market cap in USD on the supply now], oldest first. */
  ticks: [number, number][];
  /**
   * Asked with a wait: the answer was held until a change came (or the wait ran out), so the chart
   * can ask again at once (absent from older API builds, which answer at once).
   */
  held?: boolean;
}

/** One curve's current price for a feed card - see LiveCurves.quotes. */
export interface CurveQuote {
  marketCapUsd: number;
  priceUsd: number;
  /** When the price is known current (ms epoch). */
  at: number;
}

/** Pump.fun's launch supply, one billion tokens: what the curve's ticks are read on. */
const PUMP_SUPPLY = 1e9;

interface Followed {
  curve: string;
  askedAt: number;
  /** When a chart (not a feed card) last asked, null never: pins the follow (MAX_CARD_FOLLOWED). */
  chartAskedAt: number | null;
  /** When the stream last delivered the curve (ms), null never. */
  deliveredAt: number | null;
  /** When an RPC check last matched the stream (ms), null never. */
  verifiedAt: number | null;
  /** When a check found the cover broken (ms): a cover that began before it doesn't count. */
  droppedAt: number | null;
  /** A check that differed, waiting VERIFY_GRACE_MS for a delivery to explain it. */
  suspect: { at: number; state: CurveState } | null;
  /** No Pump.fun curve there: its LaunchLab pool is looked for in the discovery loop. */
  needsLaunchLab: boolean;
  /** [ms, market cap in SOL] per change. */
  ticks: [number, number][];
  coveredFrom: number | null;
  confirmedAt: number | null;
  readAt: number | null;
  complete: boolean;
  /** The address holds no curve (not a Pump.fun coin), or one quoted in a coin with no price. */
  none: boolean;
  /**
   * What the curve (and later its pool) is quoted in: null for SOL, else the coin it pairs with
   * (USD1, a tokenized stock). Ticks are its market cap in that coin, read as if it had 9 decimals.
   */
  quoteMint: string | null;
  /** A chart asked (not only a feed card): once the curve completes, its pool is followed. */
  wantPool: boolean;
  /** After bonding: the pool once read, "none" with no SOL pool there, null not found yet. */
  pool: FollowedPool | "none" | null;
  /** When the pool was last looked for (ms), null never. */
  poolSoughtAt: number | null;
  /** No Pump.fun curve there: when its Raydium LaunchLab pool (a Stonks coin) was looked for. */
  launchLabSoughtAt: number | null;
  /** `curve` is the coin's LaunchLab pool, not a Pump.fun curve: it graduates into Raydium CPMM. */
  launchLab: boolean;
}

interface FollowedPool {
  vaults: PoolVaults;
  /** The PumpSwap pool account, re-read for its virtual quote reserve; null for a Raydium CPMM pool. */
  address: string | null;
  /** The pool's virtual quote reserve (base units), priced on top of the quote vault. */
  virtualQuote: number;
  /** The vaults' balances (base units) and the slot each was delivered at (null: an RPC read). */
  base: number;
  quote: number;
  baseSlot: number | null;
  quoteSlot: number | null;
  /** Waiting on the other side of a slot (PAIR_WAIT_MS). */
  timer: ReturnType<typeof setTimeout> | null;
  /** When the vaults were last read by RPC (ms), null before the first. */
  readAt: number | null;
  /** As Followed's: the stream's last delivery, the last matching check, a broken cover. */
  deliveredAt: number | null;
  verifiedAt: number | null;
  droppedAt: number | null;
  suspect: { at: number; base: number; quote: number; virtualQuote: number } | null;
}

/** The pool `f` is priced by now, or null while it is still on its curve (or has no pool). */
function poolOf(f: Followed): FollowedPool | null {
  return f.complete && f.wantPool && f.pool !== null && f.pool !== "none" ? f.pool : null;
}

/** Nothing live prices `f` any more. */
function isDone(f: Followed): boolean {
  return f.none || (f.complete && (!f.wantPool || f.pool === "none"));
}

/**
 * A curve's market cap in SOL: its price (virtual SOL reserve over virtual token reserve, in base
 * units: lamports and 6-decimal tokens) times Pump.fun's one billion supply.
 */
export function curveMcapSol(state: Pick<CurveState, "virtualQuote" | "virtualToken">): number {
  return (state.virtualQuote / state.virtualToken) * 1e6;
}

export interface LiveCurvesDeps {
  /** Opens the websocket on first use; null: RPC reads only. */
  makeStream: ((onAccount: (key: string, data: string, slot: number | null) => void) => Stream) | null;
  reader: CurveReader | null;
  solPrice: Pick<SolPrice, "get">;
  /** Prices a coin-quoted curve's quote; without it such curves aren't followed. */
  quotePrice?: Pick<QuotePrice, "get">;
  /** Each coin's supply now, which burns can have taken under the launch billion (the process's, by default). */
  supplies?: MintSupplySource;
  /** Where its counts go (the process's chartHealth, by default). */
  health?: ChartHealth;
  now?: () => number;
}

export class LiveCurves {
  private readonly followed = new Map<string, Followed>();
  private stream: Stream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince: number | null = null;
  private readonly now: () => number;
  private readonly totals = { accountUpdates: 0, bytes: 0, credits: 0 };
  private readonly startedAt: number;
  /** Each Stonks mint's LaunchLab pool (or null: none), so a coin is scanned for once. */
  private readonly launchLabPools = new Map<string, string | null>();
  /** Graduated Stonks coins' CPMM pool vaults found so far, by mint and quote mint. */
  private readonly cpmmPools = new Map<string, PoolVaults>();
  /** Charts' held asks, by mint: each woken by the curve's next change. */
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Each loop's pass in flight ("prices", "discover", "verify"): a loop never runs twice at once. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** A pass queued behind the one in flight, shared by everyone who asked meanwhile (fresh). */
  private readonly queued = new Map<string, Promise<void>>();
  private drainedAt: number;

  constructor(private readonly deps: LiveCurvesDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.drainedAt = this.startedAt;
  }

  private get health(): ChartHealth {
    return this.deps.health ?? chartHealth();
  }

  /**
   * The changes after `after` (ms) of `mint`'s curve, following it from now on if it wasn't. With
   * `waitMs` (at most MAX_WAIT_MS), an ask with no change yet is held until the next one lands, so
   * the chart draws it the moment it does; `signal` lets go of it early (the reader left).
   */
  async read(mint: string, after: number, waitMs = 0, signal?: AbortSignal): Promise<LiveCurveAnswer> {
    const answer = await this.readOnce(mint, after, waitMs, signal);
    this.health.recordLiveTailAnswer(answer.source);
    return answer;
  }

  private async readOnce(
    mint: string,
    after: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<LiveCurveAnswer> {
    const first = await this.answer(mint, after, true);
    if (waitMs <= 0) return first;
    if (first.ticks.length > 0 || first.complete || first.source === "none" || signal?.aborted)
      return { ...first, held: true };
    await this.nextChange(mint, Math.min(waitMs, MAX_WAIT_MS), signal);
    return { ...(await this.answer(mint, after, false)), held: true };
  }

  /** Resolves on `mint`'s next recorded change, after `ms`, or when `signal` aborts. */
  private nextChange(mint: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(mint);
      if (!set) this.waiters.set(mint, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const s = this.waiters.get(mint);
        s?.delete(done);
        if (s && s.size === 0) this.waiters.delete(mint);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  /** Wakes the held asks on `mint`. */
  private wake(mint: string): void {
    const set = this.waiters.get(mint);
    if (set) for (const done of [...set]) done();
  }

  /** `seed`: may wait on a seed read (a held ask's second look doesn't). */
  private async answer(mint: string, after: number, seed: boolean): Promise<LiveCurveAnswer> {
    const now = this.now();
    const followed = this.follow(mint, now, true);
    if (!followed) return none(mint);
    const f = followed.f;
    // The first answer waits for its seed read (briefly), rather than a round later; so does the
    // first after bonding, for its pool.
    if (followed.added || (seed && f.complete && !f.none && f.pool === null))
      await this.seed(SEED_WAIT_MS, [f]);
    if (f.none) return none(mint);
    const pool = poolOf(f);
    const readAt = pool ? pool.readAt : f.readAt;
    const streamed = this.streamCovers(mint, f);
    const [usd, factor] = await Promise.all([this.usdRate(f), this.supplyFactor(mint)]);
    const source: LiveSource = readAt === null ? "pending" : streamed ? "stream" : "rpc";
    if (usd === null && source !== "pending") this.health.recordUsdMissing();
    return {
      mint,
      source: usd === null && source !== "pending" ? "pending" : source,
      venue: f.complete ? "pool" : "curve",
      complete: isDone(f),
      coveredFrom: f.coveredFrom,
      // The last real delivery, RPC read or matching check: never the ask's own time, so a stream
      // that stopped delivering reads as old here and the chart drops its "Live" pill.
      readAt: f.confirmedAt,
      ticks:
        usd === null ? [] : f.ticks.filter(([t]) => t > after).map(([t, sol]) => [t, sol * usd * factor]),
    };
  }

  /**
   * The feed cards' "Now" (GET /live/market): each mint's current market cap in USD and the moment
   * it is known current, for the coins still on their Pump.fun curve, followed from now on as a
   * chart's curve is. The curve's reserves are the price to the block, where DexScreener's figure
   * runs 45-60 s behind the market. Graduated coins, coins with no curve and curves not read yet
   * are left out: the caller keeps DexScreener's figure for those. New curves wait up to `waitMs`
   * for their seed read.
   */
  async quotes(mints: readonly string[], waitMs: number): Promise<Map<string, CurveQuote>> {
    const now = this.now();
    let added = false;
    const asked: [string, Followed][] = [];
    for (const mint of mints) {
      const followed = this.follow(mint, now);
      if (!followed) continue;
      added ||= followed.added;
      asked.push([mint, followed.f]);
    }
    if (added)
      await this.seed(
        waitMs,
        asked.map(([, f]) => f),
      );
    const out = new Map<string, CurveQuote>();
    if (asked.length === 0) return out;
    const factors = await launchSupplyFactors(
      asked.map(([mint]) => mint),
      this.deps.supplies,
    );
    for (const [mint, f] of asked) {
      if (f.none || f.complete || f.readAt === null) continue;
      const last = f.ticks[f.ticks.length - 1];
      if (!last) continue;
      const usd = await this.usdRate(f);
      if (usd === null) continue;
      const at = f.confirmedAt ?? f.readAt;
      // Reads failing and the stream not covering it: not current, DexScreener's figure stands.
      if (now - at > GAP_MS) continue;
      // The ticks are on the launch billion; the cap is put on the supply now, the price isn't one.
      out.set(mint, {
        marketCapUsd: last[1] * usd * (factors.get(mint) ?? 1),
        priceUsd: (last[1] * usd) / PUMP_SUPPLY,
        at,
      });
    }
    return out;
  }

  /**
   * Read-only: the price changes kept for `mint` (up to KEEP_MS of them) as USD market caps on its
   * supply now, as the live tail answers them, or null when it isn't followed or has no price. It
   * neither follows the coin nor counts as an ask, so it never keeps a follow alive: the chart's own
   * candles are built from these (streamCandles.ts, user ask 2026-10-19).
   */
  async history(mint: string): Promise<{
    ticks: [number, number][];
    coveredFrom: number | null;
    streamFrom: number | null;
    readAt: number | null;
  } | null> {
    const f = this.followed.get(mint);
    if (!f || f.none || f.ticks.length === 0) return null;
    const [usd, factor] = await Promise.all([this.usdRate(f), this.supplyFactor(mint)]);
    if (usd === null) return null;
    // `coveredFrom` counts RPC reads (every READ_EVERY_MS off the stream) as cover; `streamFrom` is
    // where the stream alone has delivered every change, without a break, and is null off it: only
    // that stretch makes true 1-second candles (charts audit CH-6).
    const since = this.streamCoveredSince(mint, f);
    return {
      ticks: f.ticks.map(([t, sol]) => [t, sol * usd * factor]),
      coveredFrom: f.coveredFrom,
      streamFrom: since === null || f.coveredFrom === null ? null : Math.max(since, f.coveredFrom),
      readAt: f.confirmedAt,
    };
  }

  /** What `mint`'s launch-billion ticks are multiplied by to read on its supply now (mintSupply.ts). */
  private async supplyFactor(mint: string): Promise<number> {
    return (await launchSupplyFactors([mint], this.deps.supplies)).get(mint) ?? 1;
  }

  /**
   * USD per tick unit for `f`: SOL's price for a SOL curve, else its quote coin's, scaled from the
   * 9 decimals the ticks are read at to the coin's own. Null while there is no price.
   */
  private async usdRate(f: Followed): Promise<number | null> {
    if (f.quoteMint === null) return this.deps.solPrice.get();
    const q = await this.deps.quotePrice?.get(f.quoteMint);
    return q ? q.usd * 10 ** (9 - q.decimals) : null;
  }

  /**
   * Whether `mint` is followed, its last read found it on its curve, and its price is current
   * (within GAP_MS): the live tick then leaves it out of the DexScreener lookup, since the curve
   * prices it.
   */
  onCurve(mint: string): boolean {
    const f = this.followed.get(mint);
    return !!f && !f.none && !f.complete && f.confirmedAt !== null && this.now() - f.confirmedAt <= GAP_MS;
  }

  /**
   * Starts following `mint`'s curve if it wasn't; null when it can't be followed. `chart`: a
   * chart's ask, which follows the pool after bonding too, and pins the follow.
   */
  private follow(mint: string, now: number, chart = false): { f: Followed; added: boolean } | null {
    let f = this.followed.get(mint);
    let added = false;
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve || (!this.deps.reader && !this.deps.makeStream)) return null;
      if (!this.makeRoom(chart, now)) return null;
      f = {
        curve,
        askedAt: now,
        chartAskedAt: null,
        deliveredAt: null,
        verifiedAt: null,
        droppedAt: null,
        suspect: null,
        needsLaunchLab: false,
        ticks: [],
        coveredFrom: null,
        confirmedAt: null,
        readAt: null,
        complete: false,
        none: false,
        quoteMint: null,
        wantPool: false,
        pool: null,
        poolSoughtAt: null,
        launchLabSoughtAt: null,
        launchLab: false,
      };
      this.followed.set(mint, f);
      this.ensureRunning();
      added = true;
    }
    f.askedAt = now;
    if (chart) f.chartAskedAt = now;
    f.wantPool ||= chart;
    if (!f.none && !f.complete && !f.needsLaunchLab)
      this.stream?.watch(KEY_PREFIX + mint, [f.curve], now, "account");
    const pool = poolOf(f);
    if (pool) this.watchPool(mint, pool, now);
    return { f, added };
  }

  /** A chart asked about `f` within IDLE_MS: a feed card's follow never evicts it. */
  private pinned(f: Followed, now: number): boolean {
    return f.chartAskedAt !== null && now - f.chartAskedAt <= IDLE_MS;
  }

  /**
   * Frees a slot for a new follow, if one is needed: a card's follow takes the least recently asked
   * card's slot past MAX_CARD_FOLLOWED; past MAX_FOLLOWED, the least recently asked card goes first,
   * and a chart's follow may take a chart's slot only when no card holds one. False: no room.
   */
  private makeRoom(chart: boolean, now: number): boolean {
    let cards = 0;
    let oldestCard: [string, number] | null = null;
    let oldestChart: [string, number] | null = null;
    for (const [mint, f] of this.followed) {
      if (this.pinned(f, now)) {
        if (!oldestChart || f.askedAt < oldestChart[1]) oldestChart = [mint, f.askedAt];
      } else {
        cards += 1;
        if (!oldestCard || f.askedAt < oldestCard[1]) oldestCard = [mint, f.askedAt];
      }
    }
    if (!chart && cards >= MAX_CARD_FOLLOWED && oldestCard) {
      this.drop(oldestCard[0]);
      return true;
    }
    if (this.followed.size < MAX_FOLLOWED) return true;
    const victim = oldestCard ?? (chart ? oldestChart : null);
    if (!victim) return false;
    this.drop(victim[0]);
    return true;
  }

  /**
   * Waits for the seed reads of curves just followed (a price pass that starts now, and discovery
   * with another price pass when a coin needs it), at most `waitMs`.
   */
  private async seed(waitMs: number, asked?: readonly Followed[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.seedRound(asked),
      new Promise((r) => {
        timer = setTimeout(r, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  private async seedRound(asked?: readonly Followed[]): Promise<void> {
    await this.fresh("prices", () => this.prices());
    // Only for the coins asked about: another coin's slow scan is no reason to hold this answer.
    if (!this.discoveryDue(asked)) return;
    await this.fresh("discover", () => this.discover());
    await this.fresh("prices", () => this.prices());
  }

  private watchPool(mint: string, pool: FollowedPool, now: number): void {
    this.stream?.watch(POOL_BASE_PREFIX + mint, [pool.vaults.base], now, "account");
    this.stream?.watch(POOL_QUOTE_PREFIX + mint, [pool.vaults.quote], now, "account");
    if (pool.address) this.stream?.watch(POOL_ACCOUNT_PREFIX + mint, [pool.address], now, "account");
  }

  private unwatchPool(mint: string): void {
    this.stream?.unwatch(POOL_BASE_PREFIX + mint);
    this.stream?.unwatch(POOL_QUOTE_PREFIX + mint);
    this.stream?.unwatch(POOL_ACCOUNT_PREFIX + mint);
  }

  /**
   * From when the stream has covered both of `pool`'s vaults without a break, or null (also for a
   * cover that began before a check found it broken).
   */
  private poolCoveredSince(mint: string, pool: FollowedPool): number | null {
    const base = this.stream?.coveredSince(POOL_BASE_PREFIX + mint, pool.vaults.base) ?? null;
    const quote = this.stream?.coveredSince(POOL_QUOTE_PREFIX + mint, pool.vaults.quote) ?? null;
    if (base === null || quote === null) return null;
    const since = Math.max(base, quote);
    return pool.droppedAt !== null && since <= pool.droppedAt ? null : since;
  }

  /** From when the stream has covered `f`'s curve without a break, or null (as poolCoveredSince). */
  private curveCoveredSince(mint: string, f: Followed): number | null {
    const since = this.stream?.coveredSince(KEY_PREFIX + mint, f.curve) ?? null;
    return since !== null && f.droppedAt !== null && since <= f.droppedAt ? null : since;
  }

  /** An account update the stream delivered (`slot`: when it was read, to pair a pool's vaults). */
  onAccount(key: string, data: string, slot: number | null = null): void {
    if (key.startsWith(POOL_ACCOUNT_PREFIX)) {
      const mint = key.slice(POOL_ACCOUNT_PREFIX.length);
      const f = this.followed.get(mint);
      const pool = f ? poolOf(f) : null;
      if (!f || !pool || pool.readAt === null) return;
      const now = this.now();
      pool.deliveredAt = now;
      const virtualQuote = decodePoolVirtualQuote(data);
      if (virtualQuote === pool.virtualQuote) return;
      pool.virtualQuote = virtualQuote;
      this.recordPool(mint, f, pool, this.slotAt(f, slot, now));
      return;
    }
    if (key.startsWith(POOL_BASE_PREFIX) || key.startsWith(POOL_QUOTE_PREFIX)) {
      const isBase = key.startsWith(POOL_BASE_PREFIX);
      const mint = key.slice((isBase ? POOL_BASE_PREFIX : POOL_QUOTE_PREFIX).length);
      const f = this.followed.get(mint);
      const pool = f ? poolOf(f) : null;
      const amount = decodeTokenAmount(data);
      // Like a curve's, a pool's tape opens on its seed read: both sides known at once.
      if (!f || !pool || pool.readAt === null || amount === null) return;
      pool.deliveredAt = this.now();
      if (isBase) [pool.base, pool.baseSlot] = [amount, slot];
      else [pool.quote, pool.quoteSlot] = [amount, slot];
      const other = isBase ? pool.quoteSlot : pool.baseSlot;
      if (slot !== null && other === slot) {
        if (pool.timer) clearTimeout(pool.timer);
        pool.timer = null;
        this.recordPool(mint, f, pool, this.slotAt(f, slot, this.now()));
      } else if (!pool.timer) {
        pool.timer = setTimeout(() => {
          pool.timer = null;
          if (this.followed.get(mint) === f) this.recordPool(mint, f, pool, this.slotAt(f, slot, this.now()));
        }, PAIR_WAIT_MS);
        pool.timer.unref?.();
      }
      return;
    }
    if (!key.startsWith(KEY_PREFIX)) return;
    const f = this.followed.get(key.slice(KEY_PREFIX.length));
    const state = decodeCurve(data) ?? decodeLaunchLab(data);
    // The stream only says what changed to, never what it was before: a curve not yet read
    // waits for its seed read to open the tape.
    if (!f || !state || f.readAt === null) return;
    const now = this.now();
    f.deliveredAt = now;
    this.record(key.slice(KEY_PREFIX.length), f, state, this.slotAt(f, slot, now));
  }

  /**
   * How many curves are followed (and how many of them charts pin), how many the stream covers,
   * and the chart socket's traffic and estimated credits since this process started (GET /health).
   */
  stats(): { followed: number; charts: number; streamed: number; stream: LiveCurveStreamTotals } {
    let streamed = 0;
    let charts = 0;
    const now = this.now();
    for (const [mint, f] of this.followed) {
      if (this.streamCovers(mint, f)) streamed += 1;
      if (this.pinned(f, now)) charts += 1;
    }
    const live = this.drainStreamStats();
    return {
      followed: this.followed.size,
      charts,
      streamed,
      stream: {
        connected: live?.connected ?? 0,
        accountSubscriptions: live?.accountSubscriptions ?? 0,
        accountUpdates: this.totals.accountUpdates,
        bytes: this.totals.bytes,
        credits: this.totals.credits,
        since: new Date(this.startedAt).toISOString(),
      },
    };
  }

  /** Folds the open socket's counts since the last call into the process totals. */
  private drainStreamStats() {
    const s = this.stream?.takeStats?.();
    this.drainedAt = this.now();
    if (!s) return null;
    this.totals.accountUpdates += s.accountUpdates;
    this.totals.bytes += s.bytes;
    this.totals.credits += s.credits;
    this.health.recordStreamReconnects(s.reconnects ?? 0);
    return s;
  }

  /**
   * Opens the socket and reads SOL's price ahead of the first chart (server.ts, at listen): after a
   * deploy every open chart asks again at once, and each first answer otherwise waited on both
   * (audit 2026-10-19, item 12). The socket closes again after SOCKET_IDLE_MS if no chart comes.
   */
  async warm(): Promise<void> {
    if (!this.deps.reader && !this.deps.makeStream) return;
    this.ensureRunning();
    await this.deps.solPrice.get().catch(() => null);
  }

  stop(): void {
    for (const mint of [...this.waiters.keys()]) this.wake(mint);
    for (const f of this.followed.values()) clearPoolTimer(f);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drainStreamStats();
    this.stream?.stop();
    this.stream = null;
    this.followed.clear();
  }

  /**
   * Visible for tests: one round of everything, in order: settling checks, letting go, the price
   * reads (seeding new curves), discovery with the price reads it makes due, and the stream check.
   * The timer runs the three loops side by side instead (tick), so none waits on another.
   */
  async round(): Promise<void> {
    this.settleSuspects(this.now());
    await this.seedRound();
    await this.fresh("verify", () => this.verify());
  }

  /** The timer's second: each loop starts unless its last pass is still out. */
  private tick(): void {
    const now = this.now();
    this.settleSuspects(now);
    this.health.recordStreamStall(this.stream?.stalledForMs?.() ?? 0);
    if (now - this.drainedAt >= DRAIN_EVERY_MS) this.drainStreamStats();
    void this.once("prices", () => this.prices());
    if (this.discoveryDue()) void this.once("discover", () => this.discover());
    void this.once("verify", () => this.verify());
  }

  /** Runs `run` as loop `name`'s pass, or joins the pass already in flight. */
  private once(name: string, run: () => Promise<void>): Promise<void> {
    const running = this.inflight.get(name);
    if (running) return running;
    const pass = run()
      .catch((err) => logger.warn("live curve pass failed", { pass: name, error: String(err) }))
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, pass);
    return pass;
  }

  /**
   * A pass of loop `name` that starts from now: the one in flight may have gone out before a curve
   * was followed, so the asks made meanwhile share one pass queued behind it.
   */
  private fresh(name: string, run: () => Promise<void>): Promise<void> {
    const running = this.inflight.get(name);
    if (!running) return this.once(name, run);
    let next = this.queued.get(name);
    if (!next) {
      next = running.then(() => {
        this.queued.delete(name);
        return this.once(name, run);
      });
      this.queued.set(name, next);
    }
    return next;
  }

  /** The price loop: letting go of idle curves, then the RPC reads of what the stream doesn't cover. */
  private async prices(): Promise<void> {
    const now = this.now();
    for (const [mint, f] of this.followed) {
      if (now - f.askedAt > IDLE_MS) this.drop(mint);
    }
    if (this.followed.size === 0) {
      this.emptySince ??= now;
      if (now - this.emptySince > SOCKET_IDLE_MS) this.idle();
      return;
    }
    this.emptySince = null;
    const due: string[] = [];
    for (const [mint, f] of this.followed) {
      if (f.none || f.complete || f.needsLaunchLab) continue;
      const since = this.curveCoveredSince(mint, f);
      // Streamed: one read after the subscription began, then the stream carries it.
      if (
        since !== null
          ? f.readAt === null || f.readAt < since
          : f.readAt === null || now - f.readAt >= READ_EVERY_MS
      )
        due.push(mint);
    }
    const reader = this.deps.reader;
    if (!reader) return;
    for (let i = 0; i < due.length; i += 100) {
      const mints = due.slice(i, i + 100);
      const curves = mints.map((m) => this.followed.get(m)?.curve ?? "");
      const states = await reader.getCurveStatesBatch(curves);
      mints.forEach((mint, k) => {
        const f = this.followed.get(mint);
        const state = states.get(curves[k]!);
        if (!f || state === undefined || state === "failed") return;
        const quoteMint = state === null || state.quoteIsSol ? null : (state.quoteMint ?? null);
        // No Pump.fun curve: a chart's coin may be on Raydium LaunchLab (Stonks), looked for in the
        // discovery loop.
        if (state === null && f.wantPool && !f.launchLab && reader.findLaunchLabPool) {
          f.needsLaunchLab = true;
          this.stream?.unwatch(KEY_PREFIX + mint);
          return;
        }
        if (state === null || (!state.quoteIsSol && (!quoteMint || !this.deps.quotePrice))) {
          f.none = true;
          this.stream?.unwatch(KEY_PREFIX + mint);
          return;
        }
        f.quoteMint = quoteMint;
        // Stamped with when the read went out: a change the stream delivered meanwhile is newer.
        this.record(mint, f, state, now);
        f.readAt = now;
      });
    }
    await this.poolReads(reader, now);
  }

  /** Whether any followed coin waits on discovery (a LaunchLab pool, or its pool after bonding). */
  private discoveryDue(among: Iterable<Followed> = this.followed.values()): boolean {
    for (const f of among) {
      if (f.needsLaunchLab) return true;
      if (!f.none && f.complete && f.wantPool && f.pool === null) return true;
    }
    return false;
  }

  /**
   * The discovery loop, apart from the price reads so a slow program scan holds no chart's price
   * (audit item 10), and stopping new scans after DISCOVERY_BUDGET_MS in one pass.
   */
  private async discover(): Promise<void> {
    const reader = this.deps.reader;
    if (!reader) return;
    const now = this.now();
    const deadline = now + DISCOVERY_BUDGET_MS;
    await this.launchLabRound(now, deadline);
    await this.findPools(reader, now, deadline);
  }

  /**
   * The charts' coins with no Pump.fun curve: each one's Raydium LaunchLab pool (a Stonks coin),
   * found by a program scan once per coin and followed as its curve from the next price pass on; a
   * coin with none has no live price.
   */
  private async launchLabRound(now: number, deadline: number): Promise<void> {
    const find = this.deps.reader?.findLaunchLabPool?.bind(this.deps.reader);
    for (const [mint, f] of [...this.followed]) {
      if (!f.needsLaunchLab || !find || this.followed.get(mint) !== f) continue;
      let pool = this.launchLabPools.get(mint);
      if (pool === undefined) {
        if (f.launchLabSoughtAt !== null && now - f.launchLabSoughtAt < LAUNCHLAB_RETRY_MS) continue;
        if (this.now() > deadline) break;
        f.launchLabSoughtAt = now;
        const found = await find(mint);
        if (found === "failed") continue;
        pool = found;
        if (this.launchLabPools.size >= MAX_LAUNCHLAB_POOLS) {
          const oldest = this.launchLabPools.keys().next().value;
          if (oldest !== undefined) this.launchLabPools.delete(oldest);
        }
        this.launchLabPools.set(mint, pool);
      }
      if (this.followed.get(mint) !== f) continue;
      f.needsLaunchLab = false;
      if (pool === null) {
        f.none = true;
        this.stream?.unwatch(KEY_PREFIX + mint);
        this.wake(mint);
        continue;
      }
      f.curve = pool;
      f.launchLab = true;
      this.stream?.watch(KEY_PREFIX + mint, [pool], this.now(), "account");
    }
  }

  /** After bonding, for the charts' coins: finds each graduated curve's pool. */
  private async findPools(reader: CurveReader, now: number, deadline: number): Promise<void> {
    const canRead = !!reader.getPoolVaultsBatch && !!reader.getTokenAmountsBatch;
    const sought = new Map<string, { mint: string; quoteMint: string }>();
    const cpmm: [string, Followed][] = [];
    for (const [mint, f] of this.followed) {
      if (f.none || !f.complete || !f.wantPool || f.pool !== null) continue;
      if (f.poolSoughtAt !== null && now - f.poolSoughtAt < (f.launchLab ? CPMM_RETRY_MS : READ_EVERY_MS))
        continue;
      // A LaunchLab (Stonks) coin graduates into a Raydium CPMM pool, not PumpSwap.
      if (f.launchLab) {
        cpmm.push([mint, f]);
        continue;
      }
      const quoteMint = f.quoteMint ?? WRAPPED_SOL_MINT;
      const pool = canRead ? pumpSwapPoolOf(mint, quoteMint) : undefined;
      if (!pool) f.pool = "none";
      else sought.set(pool, { mint, quoteMint });
    }
    if (!reader.getPoolVaultsBatch || !reader.getTokenAmountsBatch) return;
    // The PumpSwap lookups first: one batched read for all of them, where each CPMM coin is two scans.
    if (sought.size > 0) {
      const found = await reader.getPoolVaultsBatch(sought);
      for (const [pool, { mint }] of sought) {
        const f = this.followed.get(mint);
        const vaults = found.get(pool);
        if (!f || vaults === undefined) continue;
        f.poolSoughtAt = now;
        if (vaults === "failed") continue;
        this.setPool(mint, f, vaults, this.now(), pool);
      }
    }
    for (const [mint, f] of cpmm) {
      if (!reader.findCpmmPoolVaults) {
        f.pool = "none";
        continue;
      }
      const quoteMint = f.quoteMint ?? WRAPPED_SOL_MINT;
      const known = this.cpmmPools.get(`${mint}:${quoteMint}`);
      if (known) {
        this.setPool(mint, f, known, this.now(), null);
        continue;
      }
      if (this.now() > deadline) break;
      f.poolSoughtAt = now;
      const vaults = await reader.findCpmmPoolVaults(mint, quoteMint);
      if (vaults === "failed" || this.followed.get(mint) !== f) continue;
      if (vaults !== null) {
        if (this.cpmmPools.size >= MAX_LAUNCHLAB_POOLS) {
          const oldest = this.cpmmPools.keys().next().value;
          if (oldest !== undefined) this.cpmmPools.delete(oldest);
        }
        this.cpmmPools.set(`${mint}:${quoteMint}`, vaults);
      }
      this.setPool(mint, f, vaults, this.now(), null);
    }
  }

  /**
   * The followed pools' vaults the stream doesn't cover: read once after their subscriptions
   * begin, else every READ_EVERY_MS.
   */
  private async poolReads(reader: CurveReader, now: number): Promise<void> {
    if (!reader.getPoolVaultsBatch || !reader.getTokenAmountsBatch) return;
    const due: [string, Followed, FollowedPool][] = [];
    for (const [mint, f] of this.followed) {
      const pool = poolOf(f);
      if (!pool) continue;
      const since = this.poolCoveredSince(mint, pool);
      if (
        since !== null
          ? pool.readAt === null || pool.readAt < since
          : pool.readAt === null || now - pool.readAt >= READ_EVERY_MS
      )
        due.push([mint, f, pool]);
    }
    if (due.length === 0) return;
    const { amounts, pools } = await this.readPools(reader, due);
    for (const [mint, f, pool] of due) {
      const base = amounts.get(pool.vaults.base);
      const quote = amounts.get(pool.vaults.quote);
      if (typeof base !== "number" || typeof quote !== "number") continue;
      const read = pool.address ? pools.get(pool.address) : undefined;
      // A failed pool read keeps the last virtual reserve: it moves slowly, the vaults don't.
      const virtualQuote = read && read !== "failed" ? read.virtualQuote : pool.virtualQuote;
      Object.assign(pool, { base, quote, virtualQuote, baseSlot: null, quoteSlot: null });
      this.recordPool(mint, f, pool, now);
      pool.readAt = now;
    }
  }

  /** `due` pools' vault balances, and their pool accounts (the virtual quote reserve moves too). */
  private async readPools(reader: CurveReader, due: readonly [string, Followed, FollowedPool][]) {
    const accounts = new Map(
      due.flatMap(([mint, f, p]) =>
        p.address ? [[p.address, { mint, quoteMint: f.quoteMint ?? WRAPPED_SOL_MINT }] as const] : [],
      ),
    );
    const [amounts, pools] = await Promise.all([
      reader.getTokenAmountsBatch!(due.flatMap(([, , p]) => [p.vaults.base, p.vaults.quote])),
      accounts.size > 0
        ? reader.getPoolVaultsBatch!(accounts)
        : new Map<string, PoolVaults | null | "failed">(),
    ]);
    return { amounts, pools };
  }

  /**
   * The stream check (audit item 3): every covered curve and pool due a check (VERIFY_EVERY_MS
   * since its last RPC read or check) is read again by RPC, batched (100 accounts a call). A match
   * confirms the price as current then; a difference is held for VERIFY_GRACE_MS (settleSuspects).
   */
  private async verify(): Promise<void> {
    const reader = this.deps.reader;
    if (!reader || !this.stream) return;
    const now = this.now();
    const lastCheck = (verifiedAt: number | null, readAt: number | null) =>
      Math.max(verifiedAt ?? 0, readAt ?? 0);
    const curves: [string, Followed][] = [];
    const pools: [string, Followed, FollowedPool][] = [];
    for (const [mint, f] of this.followed) {
      if (f.none || !this.streamCovers(mint, f)) continue;
      const pool = poolOf(f);
      if (pool) {
        // Half a slot in (PAIR_WAIT_MS): the vaults would read as differing; checked next time.
        if (pool.suspect || pool.timer || now - lastCheck(pool.verifiedAt, pool.readAt) < VERIFY_EVERY_MS)
          continue;
        pools.push([mint, f, pool]);
      } else if (!f.complete && !f.suspect && now - lastCheck(f.verifiedAt, f.readAt) >= VERIFY_EVERY_MS) {
        curves.push([mint, f]);
      }
    }
    let verified = 0;
    if (curves.length > 0) {
      const states = await reader.getCurveStatesBatch(curves.map(([, f]) => f.curve));
      for (const [mint, f] of curves) {
        const state = states.get(f.curve);
        if (this.followed.get(mint) !== f || state === undefined || state === "failed" || state === null)
          continue;
        verified += 1;
        // The stream spoke while the read was out: it is alive, and its word is the newer one.
        if (f.deliveredAt !== null && f.deliveredAt > now) {
          f.verifiedAt = now;
          continue;
        }
        const last = f.ticks[f.ticks.length - 1];
        const priced = state.virtualToken > 0 && state.virtualQuote > 0;
        const same =
          state.complete === f.complete && (!priced || (!!last && samePrice(curveMcapSol(state), last[1])));
        if (!same) {
          f.suspect = { at: now, state };
          continue;
        }
        f.verifiedAt = now;
        if (last) this.recordMcap(mint, f, last[1], now);
      }
    }
    if (pools.length > 0 && reader.getTokenAmountsBatch && reader.getPoolVaultsBatch) {
      const { amounts, pools: accounts } = await this.readPools(reader, pools);
      for (const [mint, f, pool] of pools) {
        const base = amounts.get(pool.vaults.base);
        const quote = amounts.get(pool.vaults.quote);
        if (poolOf(f) !== pool || typeof base !== "number" || typeof quote !== "number") continue;
        const read = pool.address ? accounts.get(pool.address) : undefined;
        const virtualQuote = read && read !== "failed" ? read.virtualQuote : pool.virtualQuote;
        verified += 1;
        if ((pool.deliveredAt !== null && pool.deliveredAt > now) || pool.timer) {
          pool.verifiedAt = now;
          continue;
        }
        if (base !== pool.base || quote !== pool.quote || virtualQuote !== pool.virtualQuote) {
          pool.suspect = { at: now, base, quote, virtualQuote };
          continue;
        }
        pool.verifiedAt = now;
        this.recordPool(mint, f, pool, now);
      }
    }
    if (verified > 0) this.health.recordAccountsVerified(verified);
  }

  /**
   * Checks that differed VERIFY_GRACE_MS ago: a delivery since says the stream is alive (the change
   * was in flight); none says it missed the change. Then the cover is dropped (RPC reads the
   * account from the next price pass), the check's read goes on the tape, and the key is
   * resubscribed: its cover starts over once Helius confirms the new subscription.
   */
  private settleSuspects(now: number): void {
    for (const [mint, f] of this.followed) {
      const s = f.suspect;
      if (s && now - s.at >= VERIFY_GRACE_MS) {
        f.suspect = null;
        if (f.deliveredAt !== null && f.deliveredAt > s.at) f.verifiedAt = s.at;
        else {
          this.health.recordAccountMismatch("curve");
          logger.warn("stream missed a curve's change; reading it by rpc", { mint });
          f.droppedAt = now;
          this.record(mint, f, s.state, s.at);
          f.readAt = s.at;
          if (!f.complete) this.stream?.resubscribe?.(KEY_PREFIX + mint);
        }
      }
      const pool = poolOf(f);
      const p = pool?.suspect;
      if (!pool || !p || now - p.at < VERIFY_GRACE_MS) continue;
      pool.suspect = null;
      if (pool.deliveredAt !== null && pool.deliveredAt > p.at) {
        pool.verifiedAt = p.at;
        continue;
      }
      this.health.recordAccountMismatch("pool");
      logger.warn("stream missed a pool's change; reading it by rpc", { mint });
      pool.droppedAt = now;
      Object.assign(pool, {
        base: p.base,
        quote: p.quote,
        virtualQuote: p.virtualQuote,
        baseSlot: null,
        quoteSlot: null,
      });
      this.recordPool(mint, f, pool, p.at);
      pool.readAt = p.at;
      this.stream?.resubscribe?.(POOL_BASE_PREFIX + mint);
      this.stream?.resubscribe?.(POOL_QUOTE_PREFIX + mint);
      if (pool.address) this.stream?.resubscribe?.(POOL_ACCOUNT_PREFIX + mint);
    }
  }

  /** `f`'s pool once found (null: it has none, and nothing live prices it any more). */
  private setPool(
    mint: string,
    f: Followed,
    vaults: PoolVaults | null,
    now: number,
    address: string | null,
  ): void {
    f.pool =
      vaults === null
        ? "none"
        : {
            vaults,
            address,
            virtualQuote: vaults.virtualQuote,
            base: 0,
            quote: 0,
            baseSlot: null,
            quoteSlot: null,
            timer: null,
            readAt: null,
            deliveredAt: null,
            verifiedAt: null,
            droppedAt: null,
            suspect: null,
          };
    if (vaults === null) this.wake(mint);
    else this.watchPool(mint, f.pool as FollowedPool, now);
  }

  private recordPool(mint: string, f: Followed, pool: FollowedPool, at: number): void {
    // PumpSwap prices the quote vault plus the pool's virtual quote reserve (pumpSwapPool.ts).
    const quote = pool.quote + pool.virtualQuote;
    if (!(pool.base > 0) || !(quote > 0)) return;
    this.recordMcap(mint, f, curveMcapSol({ virtualQuote: quote, virtualToken: pool.base }), at);
  }

  private record(mint: string, f: Followed, state: CurveState, at: number): void {
    // A graduated curve is emptied at migration: no price, only that it is over (the pool's next).
    const priced = state.virtualToken > 0 && state.virtualQuote > 0;
    const changed = priced && this.recordMcap(mint, f, curveMcapSol(state), at);
    if (state.complete) {
      f.complete = true;
      this.stream?.unwatch(KEY_PREFIX + mint);
      if (!changed) this.wake(mint);
    }
  }

  /**
   * Adds a price at `at` to `f`'s tape (if it changed); whether it did. Every call is a real read
   * (a delivery, an RPC read or a matching check), so it also moves the price's known-current time.
   */
  private recordMcap(mint: string, f: Followed, mcap: number, at: number): boolean {
    const last = f.ticks[f.ticks.length - 1];
    if (last && at < last[0]) return false;
    if (f.confirmedAt === null || at - f.confirmedAt > GAP_MS) f.coveredFrom = at;
    f.confirmedAt = Math.max(f.confirmedAt ?? at, at);
    const changed = !last || last[1] !== mcap;
    if (changed) f.ticks.push([at, mcap]);
    let cut = 0;
    while (cut < f.ticks.length - 1 && f.ticks[cut]![0] < at - KEEP_MS) cut += 1;
    if (f.ticks.length - cut > MAX_TICKS) cut = f.ticks.length - MAX_TICKS;
    if (cut > 0) f.ticks.splice(0, cut);
    if (changed) this.wake(mint);
    return changed;
  }

  private streamCovers(mint: string, f: Followed): boolean {
    return this.streamCoveredSince(mint, f) !== null;
  }

  /**
   * From when the stream has covered what prices `f` now (its curve, or its pool) without a break,
   * with an RPC read since to start from, or null when it doesn't cover it.
   */
  private streamCoveredSince(mint: string, f: Followed): number | null {
    const pool = poolOf(f);
    if (pool) {
      const since = this.poolCoveredSince(mint, pool);
      return since !== null && pool.readAt !== null && pool.readAt >= since ? since : null;
    }
    const since = this.curveCoveredSince(mint, f);
    return since !== null && f.readAt !== null && f.readAt >= since ? since : null;
  }

  /**
   * When an update the stream delivered at `slot` happened: the slot feed's time for it where it
   * has one (ticks were stamped on arrival, a second or two after the block, so they sat off
   * Pump.fun's 1-second buckets), else `now`. Never before the tape's newest tick, which would
   * drop the price (recordMcap keeps the tape in order).
   */
  private slotAt(f: Followed, slot: number | null, now: number): number {
    const at = this.stream?.slotTime?.(slot) ?? null;
    if (at === null || at > now) return now;
    return Math.max(at, f.ticks[f.ticks.length - 1]?.[0] ?? at);
  }

  private ensureRunning(): void {
    if (!this.stream && this.deps.makeStream) {
      this.stream = this.deps.makeStream((key, data, slot) => this.onAccount(key, data, slot));
      this.stream.start();
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1_000);
      this.timer.unref?.();
    }
  }

  /** Nothing followed for a while: the socket and the timer stop until the next chart. */
  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drainStreamStats();
    this.health.recordStreamStall(0);
    this.stream?.stop();
    this.stream = null;
    this.emptySince = null;
  }

  private drop(mint: string): void {
    this.wake(mint);
    this.stream?.unwatch(KEY_PREFIX + mint);
    this.unwatchPool(mint);
    const f = this.followed.get(mint);
    if (f) clearPoolTimer(f);
    this.followed.delete(mint);
  }
}

/** Two prices from the same reserves, read two ways. */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_PRICE * Math.max(Math.abs(a), Math.abs(b));
}

function clearPoolTimer(f: Followed): void {
  if (f.pool && f.pool !== "none" && f.pool.timer) clearTimeout(f.pool.timer);
}

function none(mint: string): LiveCurveAnswer {
  return { mint, source: "none", complete: true, coveredFrom: null, readAt: null, ticks: [] };
}

/** The process's live curves: on Helius when there is a key, else nothing to follow. */
export function liveCurvesFor(
  heliusApiKey: string | undefined,
  enabled: boolean,
  reader: CurveReader | null,
  solPrice: Pick<SolPrice, "get">,
  quotePrice?: Pick<QuotePrice, "get">,
): LiveCurves {
  return new LiveCurves({
    makeStream:
      enabled && heliusApiKey
        ? (onAccount) =>
            new HeliusAccountStream(
              HeliusAccountStream.urlFor(heliusApiKey),
              () => {},
              undefined,
              (key, data, _bytes, slot) => onAccount(key, data, slot),
            )
              .metered("stream/live-curve")
              .stallAfter(COVER_STALL_MS)
        : null,
    reader: enabled ? reader : null,
    solPrice,
    quotePrice,
  });
}

let shared = new LiveCurves({ makeStream: null, reader: null, solPrice: { get: async () => null } });

/** The process's live curves, shared by every chart route (/tokens and /utilities/token). */
export function liveCurves(): LiveCurves {
  return shared;
}

/** Set once at startup (server.ts); tests set their own. */
export function setLiveCurves(curves: LiveCurves): void {
  shared.stop();
  shared = curves;
}
