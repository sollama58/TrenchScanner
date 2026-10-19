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
 */

/** A failed LaunchLab pool scan is tried again after this long. */
const LAUNCHLAB_RETRY_MS = 10_000;
/** Stonks coins' LaunchLab pools found so far (a scan each), kept across follows. */
const MAX_LAUNCHLAB_POOLS = 2_000;
/** A curve is let go once no chart has asked about it for this long. */
const IDLE_MS = 30_000;
/** Off the stream, a followed curve is read this often (1 credit per 100 curves a read). */
export const READ_EVERY_MS = 2_000;
/** How much of a curve's changes are kept: the First 15m view's span, with room. */
const KEEP_MS = 20 * 60_000;
const MAX_TICKS = 6_000;
/**
 * Curves followed at once; past it the least recently asked is let go. The feed cards' live tick
 * asks for its on-screen coins too (graduated ones hold a slot without costing anything).
 */
const MAX_FOLLOWED = 400;
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
  Partial<Pick<HeliusAccountStream, "takeStats">>;

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
type CurveReader = Pick<HeliusClient, "getCurveStatesBatch"> &
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
  now?: () => number;
}

export class LiveCurves {
  private readonly followed = new Map<string, Followed>();
  private stream: Stream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince: number | null = null;
  private busy = false;
  private readonly now: () => number;
  private readonly totals = { accountUpdates: 0, bytes: 0, credits: 0 };
  private readonly startedAt: number;
  /** Each Stonks mint's LaunchLab pool (or null: none), so a coin is scanned for once. */
  private readonly launchLabPools = new Map<string, string | null>();
  /** Charts' held asks, by mint: each woken by the curve's next change. */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly deps: LiveCurvesDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  /**
   * The changes after `after` (ms) of `mint`'s curve, following it from now on if it wasn't. With
   * `waitMs` (at most MAX_WAIT_MS), an ask with no change yet is held until the next one lands, so
   * the chart draws it the moment it does; `signal` lets go of it early (the reader left).
   */
  async read(mint: string, after: number, waitMs = 0, signal?: AbortSignal): Promise<LiveCurveAnswer> {
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
    if (followed.added || (seed && f.complete && !f.none && f.pool === null)) await this.seed(SEED_WAIT_MS);
    if (f.none) return none(mint);
    const pool = poolOf(f);
    const readAt = pool ? pool.readAt : f.readAt;
    const streamed = this.confirm(mint, f, now);
    const [usd, factor] = await Promise.all([this.usdRate(f), this.supplyFactor(mint)]);
    const source: LiveSource = readAt === null ? "pending" : streamed ? "stream" : "rpc";
    return {
      mint,
      source: usd === null && source !== "pending" ? "pending" : source,
      venue: f.complete ? "pool" : "curve",
      complete: isDone(f),
      coveredFrom: f.coveredFrom,
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
    if (added) await this.seed(waitMs);
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
      this.confirm(mint, f, now);
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
   * chart's ask, which follows the pool after bonding too.
   */
  private follow(mint: string, now: number, chart = false): { f: Followed; added: boolean } | null {
    let f = this.followed.get(mint);
    let added = false;
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve || (!this.deps.reader && !this.deps.makeStream)) return null;
      if (this.followed.size >= MAX_FOLLOWED) this.dropLeastAsked();
      f = {
        curve,
        askedAt: now,
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
    f.wantPool ||= chart;
    if (!f.none && !f.complete) this.stream?.watch(KEY_PREFIX + mint, [f.curve], now, "account");
    const pool = poolOf(f);
    if (pool) this.watchPool(mint, pool, now);
    return { f, added };
  }

  /** Waits for a round (the seed reads of curves just followed), at most `waitMs`. */
  private async seed(waitMs: number): Promise<void> {
    await Promise.race([this.round(), new Promise((r) => setTimeout(r, waitMs))]);
  }

  /** Whether the stream covers `f` now; if so, its price is known current as of `now`. */
  private confirm(mint: string, f: Followed, now: number): boolean {
    const streamed = this.streamCovers(mint, f);
    if (streamed) f.confirmedAt = now;
    return streamed;
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

  /** From when the stream has covered both of `pool`'s vaults without a break, or null. */
  private poolCoveredSince(mint: string, pool: FollowedPool): number | null {
    const base = this.stream?.coveredSince(POOL_BASE_PREFIX + mint, pool.vaults.base) ?? null;
    const quote = this.stream?.coveredSince(POOL_QUOTE_PREFIX + mint, pool.vaults.quote) ?? null;
    return base === null || quote === null ? null : Math.max(base, quote);
  }

  /** An account update the stream delivered (`slot`: when it was read, to pair a pool's vaults). */
  onAccount(key: string, data: string, slot: number | null = null): void {
    if (key.startsWith(POOL_ACCOUNT_PREFIX)) {
      const mint = key.slice(POOL_ACCOUNT_PREFIX.length);
      const f = this.followed.get(mint);
      const pool = f ? poolOf(f) : null;
      if (!f || !pool || pool.readAt === null) return;
      const virtualQuote = decodePoolVirtualQuote(data);
      if (virtualQuote === pool.virtualQuote) return;
      pool.virtualQuote = virtualQuote;
      this.recordPool(mint, f, pool, this.now());
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
      if (isBase) [pool.base, pool.baseSlot] = [amount, slot];
      else [pool.quote, pool.quoteSlot] = [amount, slot];
      const other = isBase ? pool.quoteSlot : pool.baseSlot;
      if (slot !== null && other === slot) {
        if (pool.timer) clearTimeout(pool.timer);
        pool.timer = null;
        this.recordPool(mint, f, pool, this.now());
      } else if (!pool.timer) {
        pool.timer = setTimeout(() => {
          pool.timer = null;
          if (this.followed.get(mint) === f) this.recordPool(mint, f, pool, this.now());
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
    this.record(key.slice(KEY_PREFIX.length), f, state, this.now());
  }

  /**
   * How many curves are followed, how many of them the stream covers, and the chart socket's
   * traffic and estimated credits since this process started (GET /health).
   */
  stats(): { followed: number; streamed: number; stream: LiveCurveStreamTotals } {
    let streamed = 0;
    for (const [mint, f] of this.followed) if (this.streamCovers(mint, f)) streamed += 1;
    const live = this.drainStreamStats();
    return {
      followed: this.followed.size,
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
    if (!s) return null;
    this.totals.accountUpdates += s.accountUpdates;
    this.totals.bytes += s.bytes;
    this.totals.credits += s.credits;
    return s;
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

  /** Visible for tests: one round of letting go, seeding and polling. */
  async round(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
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
        if (f.none || f.complete) continue;
        const since = this.stream?.coveredSince(KEY_PREFIX + mint, f.curve) ?? null;
        // Streamed: one read after the subscription began, then the stream carries it.
        if (
          since !== null
            ? f.readAt === null || f.readAt < since
            : f.readAt === null || now - f.readAt >= READ_EVERY_MS
        )
          due.push(mint);
      }
      if (!this.deps.reader) return;
      const launchLab: string[] = [];
      for (let i = 0; i < due.length; i += 100) {
        const mints = due.slice(i, i + 100);
        const curves = mints.map((m) => this.followed.get(m)?.curve ?? "");
        const states = await this.deps.reader.getCurveStatesBatch(curves);
        mints.forEach((mint, k) => {
          const f = this.followed.get(mint);
          const state = states.get(curves[k]!);
          if (!f || state === undefined || state === "failed") return;
          const quoteMint = state === null || state.quoteIsSol ? null : (state.quoteMint ?? null);
          // No Pump.fun curve: a chart's coin may be on Raydium LaunchLab (Stonks), looked for next.
          if (state === null && f.wantPool && !f.launchLab && this.deps.reader?.findLaunchLabPool) {
            launchLab.push(mint);
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
      await this.launchLabRound(launchLab, now);
      await this.poolRound(this.deps.reader, now);
    } catch (err) {
      logger.warn("curve read failed", { error: String(err) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * The charts' coins with no Pump.fun curve: each one's Raydium LaunchLab pool (a Stonks coin),
   * found by a program scan once per coin and followed as its curve from the next round on; a coin
   * with none has no live price.
   */
  private async launchLabRound(mints: readonly string[], now: number): Promise<void> {
    const find = this.deps.reader?.findLaunchLabPool?.bind(this.deps.reader);
    for (const mint of mints) {
      const f = this.followed.get(mint);
      if (!f || !find) continue;
      let pool = this.launchLabPools.get(mint);
      if (pool === undefined) {
        if (f.launchLabSoughtAt !== null && now - f.launchLabSoughtAt < LAUNCHLAB_RETRY_MS) continue;
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
      if (pool === null) {
        f.none = true;
        this.stream?.unwatch(KEY_PREFIX + mint);
        this.wake(mint);
        continue;
      }
      f.curve = pool;
      f.launchLab = true;
      this.stream?.watch(KEY_PREFIX + mint, [pool], now, "account");
    }
  }

  /**
   * After bonding, for the charts' coins: finds each graduated curve's pool, then reads the vaults
   * the stream doesn't cover (once after their subscriptions begin, else every READ_EVERY_MS).
   */
  private async poolRound(reader: CurveReader, now: number): Promise<void> {
    const canRead = !!reader.getPoolVaultsBatch && !!reader.getTokenAmountsBatch;
    const sought = new Map<string, { mint: string; quoteMint: string }>();
    const cpmm: [string, Followed][] = [];
    for (const [mint, f] of this.followed) {
      if (f.none || !f.complete || !f.wantPool || f.pool !== null) continue;
      if (f.poolSoughtAt !== null && now - f.poolSoughtAt < READ_EVERY_MS) continue;
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
    for (const [mint, f] of cpmm) {
      if (!reader.findCpmmPoolVaults) {
        f.pool = "none";
        continue;
      }
      f.poolSoughtAt = now;
      const vaults = await reader.findCpmmPoolVaults(mint, f.quoteMint ?? WRAPPED_SOL_MINT);
      if (vaults === "failed" || this.followed.get(mint) !== f) continue;
      this.setPool(mint, f, vaults, now, null);
    }
    if (sought.size > 0) {
      const found = await reader.getPoolVaultsBatch(sought);
      for (const [pool, { mint }] of sought) {
        const f = this.followed.get(mint);
        const vaults = found.get(pool);
        if (!f || vaults === undefined) continue;
        f.poolSoughtAt = now;
        if (vaults === "failed") continue;
        this.setPool(mint, f, vaults, now, pool);
      }
    }
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
    // The pool accounts too: their virtual quote reserve moves along with the vaults.
    const accounts = new Map(
      due.flatMap(([mint, f, p]) =>
        p.address ? [[p.address, { mint, quoteMint: f.quoteMint ?? WRAPPED_SOL_MINT }] as const] : [],
      ),
    );
    const [amounts, pools] = await Promise.all([
      reader.getTokenAmountsBatch(due.flatMap(([, , p]) => [p.vaults.base, p.vaults.quote])),
      accounts.size > 0
        ? reader.getPoolVaultsBatch(accounts)
        : new Map<string, PoolVaults | null | "failed">(),
    ]);
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

  /** Adds a price at `at` to `f`'s tape (if it changed); whether it did. */
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
    const pool = poolOf(f);
    if (pool) {
      const since = this.poolCoveredSince(mint, pool);
      return since !== null && pool.readAt !== null && pool.readAt >= since;
    }
    const since = this.stream?.coveredSince(KEY_PREFIX + mint, f.curve) ?? null;
    return since !== null && f.readAt !== null && f.readAt >= since;
  }

  private ensureRunning(): void {
    if (!this.stream && this.deps.makeStream) {
      this.stream = this.deps.makeStream((key, data, slot) => this.onAccount(key, data, slot));
      this.stream.start();
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.round(), 1_000);
      this.timer.unref?.();
    }
  }

  /** Nothing followed for a while: the socket and the timer stop until the next chart. */
  private idle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.drainStreamStats();
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

  private dropLeastAsked(): void {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [mint, f] of this.followed)
      if (f.askedAt < at) {
        at = f.askedAt;
        oldest = mint;
      }
    if (oldest !== null) this.drop(oldest);
  }
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
            ).metered("stream/live-curve")
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
