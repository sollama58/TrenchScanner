import {
  CurveTape,
  EMPTY_CURVE_PATH,
  STONKS_LAUNCHPAD,
  WRAPPED_SOL_MINT,
  createLogger,
  decodeCurve,
  decodePoolVirtualQuote,
  decodeTokenAmount,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  type CurvePathFeatures,
  type CurveState,
  type HeliusClient,
  type PoolVaults,
} from "@trenchscanner/core";
import { streamCredits, type HeliusAccountStream } from "../discovery/heliusAccountStream.js";
import { recordPricePath } from "./pricePathRecorder.js";
import { curveTapeDropped, type CurveTapeView } from "./curveCandles.js";

const logger = createLogger("curve-tape");

/**
 * The curve tape (user ask 2026-10-17: a young coin's first ~15 minutes, as granular as possible,
 * without much database, CPU or Helius): every tracked Pump.fun coin younger than
 * CURVE_TAPE_MAX_AGE_MINUTES has its bonding curve followed on the Helius websocket
 * (accountSubscribe), so each change of its price and reserves lands in core's CurveTape the moment
 * the block confirms. Helius sends at most one update per changed block (~2.5 a second) whatever
 * the number of trades in it, about 0.5 KB each at 2 credits per 0.1 MB: a quiet coin costs
 * nothing, the busiest about 1.5 credits a minute.
 *
 * The stream only speaks on a change, so each curve is read once by RPC when its subscription
 * starts (1 credit per 100 curves) and the tape runs from there. Curves the stream doesn't cover
 * (no stream, a refused subscription, a dropped connection, or the day's credit pace spent) are
 * read every CURVE_TAPE_POLL_SECONDS instead, the CURVE_TAPE_POLL_MAX_MINTS nearest the band
 * first. Nothing is written to the database: the features ride on the decision's row.
 *
 * Graduation doesn't end the chart's record (user report 2026-10-23: a coin that bonded at 14:22
 * had no candles from then until a chart opened at 14:30, drawn flat across a 2x). When a followed
 * curve completes, the coin's PumpSwap pool is followed in its place on the same socket (its two
 * vaults and the pool account, read once by RPC when the subscriptions start, polled by RPC where
 * the stream doesn't reach), until the coin is past the tape's age or POOL_FOLLOW_MS after it
 * graduated, whichever is later. Its changes go on a tape of their own (the curve's features and
 * prices stay the curve's), which the chart's candle writer saves as "pool" bars (curveCandles.ts).
 */

export const CURVE_STREAM_KEY_PREFIX = "curve:";
/** The stream keys of a graduated coin's pool: `curve-pool:base:<mint>`, `:quote:`, `:account:`. */
export const POOL_STREAM_KEY_PREFIX = "curve-pool:";
/** A graduated coin's pool is followed at least this long after it graduated. */
export const POOL_FOLLOW_MS = 15 * 60_000;
/**
 * A swap changes both vaults in one slot, delivered as two updates: the price is recorded once
 * both sides of a slot are in, or this long after one side came alone (a plain transfer in). One
 * side alone would draw a spike: the coin's vault moved, the SOL against it not yet.
 */
const PAIR_WAIT_MS = 400;

type CurveStream = Pick<HeliusAccountStream, "watch" | "unwatch" | "coveredSince">;
/** The pool reads are optional: without them, a graduated coin is let go as before. */
type CurveReader = Pick<HeliusClient, "getCurveStatesBatch"> &
  Partial<Pick<HeliusClient, "getPoolVaultsBatch" | "getTokenAmountsBatch">>;

export interface CurveTapeConfig {
  maxAgeMinutes: number;
  /**
   * Age past which a followed coin's curve path reads as null (CURVE_TAPE_MAX_AGE_MINUTES). The
   * price path recorder follows coins longer than that, but the scoring features stay as trained:
   * null for coins past it. Defaults to maxAgeMinutes.
   */
  featureMaxAgeMinutes?: number;
  /**
   * Age to which a coin a seat alerted on is followed, on the watchlist or not, for the chart's
   * 1-second candles (CURVE_TAPE_ALERTED_MINUTES, user decision 2026-10-23). Defaults to maxAgeMinutes.
   */
  alertedMaxAgeMinutes?: number;
  /**
   * Past the first alertedAlwaysMinutes from the ask, an asked coin is followed on to
   * alertedMaxAgeMinutes only while it traded within alertedIdleMinutes (user decision 2026-10-24:
   * "6 hours, only while there is active trading within the last 5 min"). A coin let go idle is not
   * followed again until a new ask. Defaults: always, and never idle.
   */
  alertedAlwaysMinutes?: number;
  alertedIdleMinutes?: number;
  /**
   * Age to which a watchlist coin still near the band is followed (CURVE_TAPE_NEAR_BAND_MINUTES,
   * user report 2026-10-24: a coin that climbed into the feed after half an hour had no 1-second
   * bars between then and its detection). Defaults to maxAgeMinutes.
   */
  nearBandMaxAgeMinutes?: number;
  maxMints: number;
  streamCreditsPerDay: number;
  pollSeconds: number;
  pollMaxMints: number;
  /**
   * The launches created since the last scan cycle (the PumpPortal stream's and Jupiter's newest),
   * followed from the next round rather than from the cycle that lists them, ~25 s later (user ask
   * 2026-10-20: the entry watch reads their price off the curve, not Jupiter).
   */
  newLaunches?: () => string[];
  /**
   * Of new launches, the ones confirmed not Mayhem (user decision: Mayhem coins are never followed
   * or read). Unset, every new launch is followed.
   */
  screenLaunches?: (mints: string[]) => Promise<string[]>;
}

interface Followed {
  curve: string;
  /** Position in the watchlist's order (near the band first): the polls go to the lowest. */
  rank: number;
  /** When the tape was last read by RPC (ms epoch), null before the first read. */
  readAt: number | null;
  /** The coin's launch (or first sighting), ms epoch. */
  bornAt: number;
  /** Followed until this moment (ms epoch): longer for a coin called or charted (followYoungCurves). */
  until: number;
  /** When it was first followed (ms epoch). */
  followedAt?: number;
  /** Its path was saved for price pathing as it aged out, while it is followed on (drop). */
  pathSaved?: boolean;
  /** Reads in a row that found no curve account (round): a brand-new coin's is given a moment to confirm. */
  misses?: number;
}

/**
 * How long after its launch a coin whose curve account a read did not find is kept and read again,
 * and how many such reads in a row it is allowed. A read at `confirmed` commitment a moment after
 * the launch can find no account yet (the launch was seen `processed`), and until 2026-10-24 that
 * one null read dropped the coin for good: no 1-second tape, and no chart until it was opened by
 * hand and the API's ask followed it again (chart audit 2026-10-24).
 */
export const NULL_READ_GRACE_MS = 3 * 60_000;
export const NULL_READ_MAX_MISSES = 5;

/**
 * Asked coins let go for trading no more (followYoungCurves), by the ask's time (ms epoch): not
 * followed again until a new ask.
 */
const idleDropped = new Map<string, number>();
const MAX_IDLE_DROPPED = 20_000;

type PoolPart = "base" | "quote" | "account";
const POOL_PARTS: readonly PoolPart[] = ["base", "quote", "account"];

/** A graduated coin's PumpSwap pool, followed for the chart's candles. */
interface PoolFollowed {
  /** The pool account (pumpSwapPoolOf: the canonical SOL pool its curve migrated to). */
  address: string;
  /** Its vaults, null until the pool's account is read (it is created at migration). */
  vaults: PoolVaults | null;
  /** Let go after this (ms epoch). */
  until: number;
  /** When it was first followed (ms epoch). */
  followedAt: number;
  /** When the pool was last read by RPC (ms epoch), null before the first read. */
  readAt: number | null;
  /** The vaults' balances (base units) and the pool's virtual quote reserve, as last read. */
  base: number | null;
  quote: number | null;
  virtualQuote: number;
  /** The slot each vault's newest stream update was read at. */
  baseSlot: number | null;
  quoteSlot: number | null;
  /** One side of a slot came alone at this time: recorded when the other comes, or PAIR_WAIT_MS on. */
  pendingAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Rounds that found no pool account yet: let go after POOL_MISS_LIMIT (the coin has no pool). */
  misses: number;
}

/**
 * Rounds a pool is asked for before the coin is taken to have none: a graduating coin's pool
 * appears within seconds of its curve completing, and a coin asked about long after (a chart
 * opened on it) has its pool at once or not at all.
 */
export const POOL_MISS_LIMIT = 60;

// Kept long enough for the price path recorder's 30 minutes (the features still read 16). Memory
// follows the stream's update rate, which its daily credit cap bounds, not the number of coins.
const tape = new CurveTape({ keepMs: 31 * 60_000, maxTicks: 6_000 });
const followed = new Map<string, Followed>();
/** Graduated coins' pools and their own tape: the curve's features and prices never read them. */
const poolTape = new CurveTape({ keepMs: 31 * 60_000, maxTicks: 6_000 });
const pools = new Map<string, PoolFollowed>();
/** Mints whose curve address holds no curve (not Pump.fun) or a graduated one: not asked again. */
const done = new Set<string>();
const MAX_DONE = 20_000;
/** Mints whose PumpSwap pool was asked for POOL_MISS_LIMIT rounds and never appeared. */
const noPool = new Set<string>();

let stream: CurveStream | null = null;
let reader: CurveReader | null = null;
let cfg: CurveTapeConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
/** The stream is off for the rest of the pace: its credits ran past their share of the day. */
let paused = false;
/**
 * The pools' subscriptions are off: the stream is past POOL_PACE_SHARE of its pace. A graduated
 * coin's pool (three accounts, most of the stream's bytes; #974 and #983 follow alerted coins' pools
 * for two hours) is let go before the curves are, so the young curves' 1-second bars and the
 * scoring that reads them keep going (API audit 2026-10-23).
 */
let poolsPaused = false;
/** The share of the stream's pace the pools may take before they are let go. */
export const POOL_PACE_SHARE = 0.6;
let day = "";
/** The stream's bytes today: credits are figured on the total, as a single update rounds to none. */
let dayStreamBytes = 0;
let stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0, poolUpdates: 0 };

const keyOf = (mint: string) => `${CURVE_STREAM_KEY_PREFIX}${mint}`;
const poolKeyOf = (part: PoolPart, mint: string) => `${POOL_STREAM_KEY_PREFIX}${part}:${mint}`;

/** Starts the curve tape; returns its stop. `helius` reads the curves, `heliusStream` follows them (null: polls only). */
export function startCurveTape(
  helius: CurveReader,
  heliusStream: CurveStream | null,
  config: CurveTapeConfig,
) {
  reader = helius;
  stream = heliusStream;
  cfg = config;
  timer = setInterval(() => void round(), config.pollSeconds * 1_000);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const mint of followed.keys()) stream?.unwatch(keyOf(mint));
    followed.clear();
    for (const mint of [...pools.keys()]) dropPool(mint, false);
    reader = null;
    stream = null;
    cfg = null;
  };
}

/** An account update the Helius stream delivered under a curve key. */
export function onCurveStreamUpdate(key: string, data: string, bytes: number, now = Date.now()): void {
  const mint = key.slice(CURVE_STREAM_KEY_PREFIX.length);
  stats.updates += 1;
  stats.bytes += bytes;
  dayStreamBytes += bytes;
  const state = decodeCurve(data);
  if (!state) return;
  tape.record(mint, now, state, "stream");
  if (state.complete) graduate(mint, state, now);
}

/**
 * An account update the Helius stream delivered under a pool key (POOL_STREAM_KEY_PREFIX), with the
 * slot it was read at: a vault's balance, or the pool's virtual quote reserve.
 */
export function onPoolStreamUpdate(
  key: string,
  data: string,
  bytes: number,
  slot: number | null = null,
  now = Date.now(),
): void {
  const rest = key.slice(POOL_STREAM_KEY_PREFIX.length);
  const cut = rest.indexOf(":");
  const part = rest.slice(0, cut) as PoolPart;
  const mint = rest.slice(cut + 1);
  stats.updates += 1;
  stats.poolUpdates += 1;
  stats.bytes += bytes;
  dayStreamBytes += bytes;
  const p = pools.get(mint);
  if (!p || cut < 0) return;
  if (part === "account") {
    const virtualQuote = decodePoolVirtualQuote(data);
    if (virtualQuote === p.virtualQuote) return;
    p.virtualQuote = virtualQuote;
    recordPool(mint, p, now, "stream");
    return;
  }
  const amount = decodeTokenAmount(data);
  if (amount === null) return;
  if (part === "base") {
    p.base = amount;
    p.baseSlot = slot;
  } else {
    p.quote = amount;
    p.quoteSlot = slot;
  }
  // Both sides of the slot are in: the price is whole.
  if (slot !== null && p.baseSlot === slot && p.quoteSlot === slot) {
    flushPair(mint, p, p.pendingAt ?? now);
    return;
  }
  if (p.pendingAt === null) {
    p.pendingAt = now;
    p.timer = setTimeout(() => {
      if (pools.get(mint) === p) flushPair(mint, p, p.pendingAt ?? Date.now());
    }, PAIR_WAIT_MS);
    p.timer.unref?.();
  }
}

/** Records a pool's price as its vaults stand, the pending side waited on no longer. */
function flushPair(mint: string, p: PoolFollowed, at: number): void {
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  p.pendingAt = null;
  recordPool(mint, p, at, "stream");
}

/**
 * The pool as a curve state for the tape: PumpSwap prices the quote vault plus the pool's virtual
 * quote reserve over the coin's vault (pumpSwapPool.ts), in the curve's units (lamports per raw
 * token unit), so its bars come out on the same market cap scale; its SOL vault moves as the
 * curve's real reserve did. Null until both vaults are read.
 */
export function poolCurveState(
  base: number | null,
  quote: number | null,
  virtualQuote: number,
): CurveState | null {
  if (base === null || quote === null || !(base > 0) || !(quote + virtualQuote > 0)) return null;
  return {
    virtualToken: base,
    virtualQuote: quote + virtualQuote,
    realQuote: quote,
    complete: false,
    quoteIsSol: true,
  };
}

function recordPool(mint: string, p: PoolFollowed, at: number, source: "stream" | "read"): void {
  const state = poolCurveState(p.base, p.quote, p.virtualQuote);
  if (state) poolTape.record(mint, at, state, source);
}

/**
 * A followed curve completed: the coin is let go as a curve (its path saved, its last bars
 * queued), and its PumpSwap pool followed in its place for the chart, when its curve was quoted in
 * SOL and the pool reads are there.
 */
function graduate(mint: string, state: CurveState, now: number): void {
  const f = followed.get(mint);
  // The emptied curve may not say what it was quoted in any more: the tape held it.
  const quoteIsSol = tape.ticksAfter(mint, Infinity)?.quoteIsSol ?? state.quoteIsSol;
  drop(mint, true);
  if (!f || !cfg || !quoteIsSol || !reader?.getPoolVaultsBatch || !reader.getTokenAmountsBatch) return;
  // The curve just completed: its pool is about to exist, whatever an earlier ask found.
  noPool.delete(mint);
  followPool(mint, Math.max(f.until, now + POOL_FOLLOW_MS));
}

/**
 * Follows the coin's PumpSwap pool for the chart's 1-second bars until `until` (longer if it is
 * followed already): at graduation, and for a coin called or charted after it graduated (its curve
 * is done; user report 2026-10-23: a coin called after graduating, and one whose chart was
 * opened an hour later, had nothing of ours recorded). The pool's account is read on the next
 * round (poolRound); a coin found to have no pool is not asked again.
 */
function followPool(mint: string, until: number): void {
  const p = pools.get(mint);
  if (p) {
    p.until = Math.max(p.until, until);
    return;
  }
  if (noPool.has(mint) || !reader?.getPoolVaultsBatch || !reader.getTokenAmountsBatch) return;
  const address = pumpSwapPoolOf(mint);
  if (!address) return;
  pools.set(mint, {
    address,
    vaults: null,
    until,
    followedAt: Date.now(),
    readAt: null,
    base: null,
    quote: null,
    virtualQuote: 0,
    baseSlot: null,
    quoteSlot: null,
    pendingAt: null,
    timer: null,
    misses: 0,
  });
}

function watchPool(mint: string, p: PoolFollowed, now: number): void {
  if (!p.vaults || poolsPaused) return;
  stream?.watch(poolKeyOf("base", mint), [p.vaults.base], now, "account");
  stream?.watch(poolKeyOf("quote", mint), [p.vaults.quote], now, "account");
  stream?.watch(poolKeyOf("account", mint), [p.address], now, "account");
}

function unwatchPool(mint: string): void {
  for (const part of POOL_PARTS) stream?.unwatch(poolKeyOf(part, mint));
}

/** From when the stream has covered all of a pool (both vaults and the account), or null. */
function poolCoveredSince(mint: string, p: PoolFollowed, now: number): number | null {
  if (!p.vaults || poolsPaused || !stream) return null;
  const since = [
    stream.coveredSince(poolKeyOf("base", mint), p.vaults.base, now),
    stream.coveredSince(poolKeyOf("quote", mint), p.vaults.quote, now),
    stream.coveredSince(poolKeyOf("account", mint), p.address, now),
  ];
  return since.some((s) => s == null) ? null : Math.max(...(since as number[]));
}

/** Lets go of a pool: its last bars queued for the candle writer when `save`. */
function dropPool(mint: string, save = true): void {
  const p = pools.get(mint);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pools.delete(mint);
  unwatchPool(mint);
  if (save) curveTapeDropped(mint, poolTape, Date.now(), "pool");
  poolTape.forget(mint);
}

/** A coin as followYoungCurves reads it. */
interface TrackedCoin {
  mintAddress: string;
  launchedAt: Date | null;
  firstSeenAt: Date;
  launchpad: string | null;
}

/**
 * A coin a seat alerted on, a call queued or a chart opened (`askedAt`: when): followed from the
 * ask for alertedMaxAgeMinutes whatever its age. Without `askedAt`, to that age from its launch.
 */
export interface AskedCoin extends TrackedCoin {
  askedAt?: Date;
}

/**
 * The scan's watchlist this cycle, in its order: the young Pump.fun coins in it are followed (up
 * to CURVE_TAPE_MAX_MINTS), and the ones that left it or aged out are dropped. `asked`: coins a
 * seat alerted on, a call queued or a chart opened lately (curatedAlerts, the candle store's
 * backfill asks), followed for alertedMaxAgeMinutes from the ask, on the watchlist or not and
 * whatever their age (user report 2026-10-23: a coin called two hours after its launch, or
 * charted later still, was never followed, so its chart had nothing of ours). A coin whose curve
 * is done (graduated, or no curve) is followed on its PumpSwap pool instead when asked.
 * `nearBand`: the watchlist's coins last seen near the band, followed to nearBandMaxAgeMinutes from
 * launch while they stay there, so a coin detected after the young age has its 1-second bars from
 * launch to its detection (user report 2026-10-24).
 */
export function followYoungCurves(
  tracked: readonly TrackedCoin[],
  now = Date.now(),
  asked: readonly AskedCoin[] = [],
  nearBand: ReadonlySet<string> = new Set(),
): void {
  if (!cfg) return;
  const maxAgeMs = cfg.maxAgeMinutes * 60_000;
  const askedForMs = Math.max(maxAgeMs, (cfg.alertedMaxAgeMinutes ?? 0) * 60_000);
  const nearBandMs = Math.max(maxAgeMs, (cfg.nearBandMaxAgeMinutes ?? 0) * 60_000);
  const alwaysMs = (cfg.alertedAlwaysMinutes ?? Infinity) * 60_000;
  const idleMs = (cfg.alertedIdleMinutes ?? Infinity) * 60_000;
  // Its last trade (the tape's newest change), or when it was first followed: none yet is a grace.
  const lastActive = (mint: string): number | null => {
    const f = followed.get(mint);
    const p = pools.get(mint);
    const at = Math.max(
      tape.lastAt(mint) ?? -Infinity,
      poolTape.lastAt(mint) ?? -Infinity,
      f?.followedAt ?? -Infinity,
      p?.followedAt ?? -Infinity,
    );
    return Number.isFinite(at) ? at : null;
  };
  // Past the ask's first alwaysMs, an asked coin stays followed only while it trades. One not
  // followed now (a restart, or a ask past its first hours) gets idleMs to show a trade.
  const idle = (mint: string, askedAt: number): boolean => {
    if (idleDropped.get(mint) === askedAt) return true;
    if (now <= askedAt + alwaysMs) return false;
    const at = lastActive(mint);
    if (at === null || now - at <= idleMs) return false;
    if (idleDropped.size >= MAX_IDLE_DROPPED) idleDropped.clear();
    idleDropped.set(mint, askedAt);
    return true;
  };
  const wanted = new Map<string, { rank: number; bornAt: number; until: number; asked: boolean }>();
  const askedPools = new Map<string, number>();
  /** Pools asked about that went idle: let go now rather than at their horizon. */
  const idlePools = new Set<string>();
  // The asked coins first: they must not wait behind the watchlist for a seat under the cap.
  const all: { coin: AskedCoin; isAsked: boolean }[] = [
    ...asked.map((coin) => ({ coin, isAsked: true })),
    ...tracked.map((coin) => ({ coin, isAsked: false })),
  ];
  for (const { coin: t, isAsked } of all) {
    if (wanted.size >= cfg.maxMints) break;
    if (wanted.has(t.mintAddress) || t.launchpad === STONKS_LAUNCHPAD) continue;
    const bornAt = (t.launchedAt ?? t.firstSeenAt).getTime();
    const askedAt = isAsked ? t.askedAt?.getTime() : undefined;
    const until = !isAsked
      ? bornAt + (nearBand.has(t.mintAddress) ? nearBandMs : maxAgeMs)
      : askedAt !== undefined
        ? Math.max(bornAt + maxAgeMs, askedAt + askedForMs)
        : bornAt + askedForMs;
    if (now > until) continue;
    // Past what its age alone would give it (the watchlist's, or the young age), the ask's hours
    // only while it trades.
    const ownUntil = bornAt + (nearBand.has(t.mintAddress) ? nearBandMs : maxAgeMs);
    if (askedAt !== undefined && now > ownUntil && idle(t.mintAddress, askedAt)) {
      if (done.has(t.mintAddress)) idlePools.add(t.mintAddress);
      continue;
    }
    if (done.has(t.mintAddress)) {
      if (isAsked) askedPools.set(t.mintAddress, Math.max(askedPools.get(t.mintAddress) ?? 0, until));
      continue;
    }
    wanted.set(t.mintAddress, { rank: wanted.size, bornAt, until, asked: isAsked });
  }
  for (const mint of followed.keys()) if (!wanted.has(mint)) drop(mint, false);
  for (const [mint, w] of wanted) {
    let f = followed.get(mint);
    if (!f) {
      const curve = pumpCurveAddressOf(mint);
      if (!curve) continue;
      f = { curve, rank: w.rank, readAt: null, bornAt: w.bornAt, until: w.until, followedAt: now };
      followed.set(mint, f);
    }
    f.rank = w.rank;
    f.until = Math.max(w.until, w.asked ? w.until : f.bornAt + maxAgeMs);
    // Followed from young past the young age (near the band, called or charted): its young path is
    // saved for price pathing as it ages, as it was when the coin was let go then (the tape keeps
    // 31 minutes). A coin first followed when older is saved when let go, as before.
    if (!f.pathSaved && now > f.bornAt + maxAgeMs && (f.followedAt ?? 0) <= f.bornAt + maxAgeMs) {
      f.pathSaved = true;
      recordPricePath(mint, tape.snapshot(mint), "aged");
    }
    // Again every cycle: it keeps the subscription from being evicted as unwatched.
    if (!paused) stream?.watch(keyOf(mint), [f.curve], now, "account");
  }
  // Graduated (or curveless) coins asked about: their pools, to the ask's horizon.
  for (const [mint, until] of askedPools) followPool(mint, until);
  // Graduated coins' pools are kept to their own horizon, on the watchlist or not: an asked
  // coin's no longer once it stopped trading.
  for (const [mint, p] of pools) {
    if (now > p.until || (idlePools.has(mint) && !askedPools.has(mint))) dropPool(mint);
    else watchPool(mint, p, now);
  }
}

/**
 * Follows launches the scan hasn't listed yet, ahead of the curves it has (rank 0: polled first
 * while the stream is off). The next cycle's followYoungCurves keeps them, or drops the ones that
 * did not make its watchlist (a Mayhem coin, set aside at discovery).
 */
function followNewLaunches(mints: readonly string[], now: number): void {
  if (!cfg) return;
  for (const mint of mints) {
    if (followed.size >= cfg.maxMints) break;
    if (followed.has(mint) || done.has(mint)) continue;
    const curve = pumpCurveAddressOf(mint);
    if (!curve) continue;
    followed.set(mint, {
      curve,
      rank: 0,
      readAt: null,
      bornAt: now,
      until: now + cfg.maxAgeMinutes * 60_000,
      followedAt: now,
    });
    if (!paused) stream?.watch(keyOf(mint), [curve], now, "account");
  }
}

/**
 * The curve path features for a mint as of `now`: all null when its curve isn't followed, or when
 * the coin is past the features' age (followed longer only for the price path recorder).
 */
export function curvePathOf(mint: string, now = Date.now()): CurvePathFeatures {
  const f = followed.get(mint);
  const maxAgeMs = (cfg?.featureMaxAgeMinutes ?? cfg?.maxAgeMinutes ?? Infinity) * 60_000;
  return f && now - f.bornAt <= maxAgeMs ? tape.features(mint, now) : { ...EMPTY_CURVE_PATH };
}

/**
 * A followed coin's curve price now (quote per token), from the stream's latest change; null when
 * the coin isn't followed or its tape is not current. Read by the entry watch (entryWatch.ts).
 */
export function curvePriceOf(mint: string, now = Date.now()): number | null {
  return followed.has(mint) ? tape.priceNow(mint, now) : null;
}

/**
 * Curve prices the candidate watcher can grade from between `afterMs` and `untilMs`. The tape
 * and the watcher run in this process; nothing is written for the label. Empty when this mint
 * has no cover (an older coin, a graduate already dropped, a restart).
 *
 * Only up to the uniform follow age (maxAgeMinutes from the coin's birth): past it the tape still
 * follows coins a seat alerted on or a chart opened, and grading only those on intra-minute wicks
 * would tie the label to the model's own picks and to later attention (audit 2026-10-23, WC-2).
 */
export function curveLabelPrices(mint: string, afterMs: number, untilMs: number) {
  const f = followed.get(mint);
  const until = f && cfg ? Math.min(untilMs, f.bornAt + cfg.maxAgeMinutes * 60_000) : untilMs;
  return tape.labelPrices(mint, afterMs, Math.max(afterMs, until));
}

/**
 * The coins followed and their changes, for the chart's 1-second candles (curveCandles.ts): the
 * curves, then the graduated coins' pools.
 */
export const curveTapeView: CurveTapeView = {
  mints: () => [...followed.keys(), ...[...pools.keys()].filter((m) => !followed.has(m))],
  ticksAfter: (mint, after) =>
    followed.has(mint) ? tape.ticksAfter(mint, after) : poolTape.ticksAfter(mint, after),
  sourceOf: (mint) => (!followed.has(mint) && pools.has(mint) ? "pool" : "curve"),
};

/** Counts since the last call, for the scan's heartbeat; null while the tape is off. */
export function takeCurveTapeStats(now = Date.now()) {
  if (!cfg) return null;
  let streamed = 0;
  for (const [mint, f] of followed) if (stream?.coveredSince(keyOf(mint), f.curve) != null) streamed += 1;
  let poolsStreamed = 0;
  for (const [mint, p] of pools) if (poolCoveredSince(mint, p, now) !== null) poolsStreamed += 1;
  rollDay(now);
  const out = {
    following: followed.size,
    streamed,
    pools: pools.size,
    poolsStreamed,
    ...stats,
    streamCredits: streamCredits(stats.bytes),
    // getMultipleAccounts: 1 credit per call of up to 100 curves.
    readCredits: stats.readCalls,
    streamCreditsToday: Math.round(streamCredits(dayStreamBytes)),
    paused: paused ? 1 : 0,
    poolsPaused: poolsPaused ? 1 : 0,
  };
  stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0, poolUpdates: 0 };
  return out;
}

function drop(mint: string, forGood: boolean): void {
  const f = followed.get(mint);
  if (followed.delete(mint)) stream?.unwatch(keyOf(mint));
  // The path the tape held is saved as training data for predictive price pathing (when it is on),
  // unless it was saved as the coin aged and it was followed on (followYoungCurves).
  if (!f?.pathSaved) recordPricePath(mint, tape.snapshot(mint), forGood ? "graduated" : "aged");
  // And its last 1-second chart candles (curveCandles.ts).
  curveTapeDropped(mint, tape);
  tape.forget(mint);
  if (forGood) {
    if (done.size >= MAX_DONE) done.clear();
    done.add(mint);
  }
}

function rollDay(now: number): void {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dayStreamBytes = 0;
  }
}

/**
 * Whether the stream's spend is past its share of the day so far: the day's cap times the share of
 * the UTC day gone, plus a tenth of the cap so a busy morning isn't cut at once.
 */
export function overStreamPace(creditsToday: number, capPerDay: number, now: number): boolean {
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const share = (now - dayStart) / 86_400_000;
  return creditsToday > capPerDay * (share + 0.1);
}

/** One round: the pace check, then one batched read of the curves to seed and to poll. Visible for tests. */
export async function round(now = Date.now()): Promise<void> {
  if (!cfg || !reader || busy) return;
  busy = true;
  try {
    rollDay(now);
    const credits = streamCredits(dayStreamBytes);
    const over = overStreamPace(credits, cfg.streamCreditsPerDay, now);
    const poolsOver = over || overStreamPace(credits, cfg.streamCreditsPerDay * POOL_PACE_SHARE, now);
    if (poolsOver !== poolsPaused) {
      poolsPaused = poolsOver;
      logger.info(
        poolsOver ? "pool stream paused: past its share of the credit pace" : "pool stream resumed",
        {
          streamCreditsToday: Math.round(credits),
          pools: pools.size,
        },
      );
      for (const [mint, p] of pools) {
        if (poolsOver) unwatchPool(mint);
        else watchPool(mint, p, now);
      }
    }
    if (over !== paused) {
      paused = over;
      logger.info(over ? "curve stream paused: past its credit pace" : "curve stream resumed", {
        streamCreditsToday: Math.round(credits),
      });
      for (const [mint, f] of followed) {
        if (over) stream?.unwatch(keyOf(mint));
        else stream?.watch(keyOf(mint), [f.curve], now, "account");
      }
    }
    const unseen = (cfg.newLaunches?.() ?? []).filter((m) => !followed.has(m) && !done.has(m));
    followNewLaunches(
      cfg.screenLaunches && unseen.length > 0 ? await cfg.screenLaunches(unseen) : unseen,
      now,
    );
    await poolRound(now);
    const toRead: string[] = [];
    /** The seeds' stream covers: confirmed as soon as the read lands, not a round later. */
    const seeding = new Map<string, number>();
    let polls = 0;
    let seeds = 0;
    for (const [mint, f] of followed) {
      const since = paused ? null : (stream?.coveredSince(keyOf(mint), f.curve) ?? null);
      if (since !== null) {
        // Streamed: read once after the subscription began, then the stream carries it.
        if (f.readAt === null || f.readAt < since) {
          toRead.push(mint);
          seeding.set(mint, since);
          seeds += 1;
        } else tape.confirmStreamed(mint, since, now);
      } else if (f.rank < cfg.pollMaxMints) {
        toRead.push(mint);
        polls += 1;
      }
    }
    if (toRead.length === 0) return;
    const curves = toRead.map((mint) => followed.get(mint)!.curve);
    const states = await reader.getCurveStatesBatch(curves);
    stats.readCalls += Math.ceil(curves.length / 100);
    stats.curvesRead += curves.length;
    stats.polled += polls;
    stats.seeded += seeds;
    toRead.forEach((mint, i) => {
      const f = followed.get(mint);
      const state = states.get(curves[i]!);
      if (!f || state === undefined || state === "failed") return;
      if (state === null) {
        // No curve account (closed, or not yet confirmed): a brand-new coin's is read again next
        // round for a few rounds before the coin is let go for good.
        f.misses = (f.misses ?? 0) + 1;
        if (f.readAt === null && now - f.bornAt < NULL_READ_GRACE_MS && f.misses < NULL_READ_MAX_MISSES)
          return;
        drop(mint, true);
        return;
      }
      // Stamped with when the read went out: a change the stream delivered while it was in
      // flight is newer, and the read doesn't overwrite it.
      tape.record(mint, now, state, "read");
      f.readAt = now;
      f.misses = 0;
      // A seed on a covered stream: the tape runs on the stream from this read, rather than from
      // the next round's confirmation (the chart's 1-second bars began a round late: chart audit
      // 2026-10-24).
      const since = seeding.get(mint);
      if (since !== undefined) tape.confirmStreamed(mint, since, now);
      if (state.complete) graduate(mint, state, now);
    });
  } catch (err) {
    logger.warn("curve read failed", { error: String(err) });
  } finally {
    busy = false;
  }
}

/**
 * The pools' part of a round: the expired let go, the new ones' accounts read for their vaults
 * (the pool appears at migration, a moment after the curve completes, so it is asked each round
 * until it does), and one batched read of the vaults to seed the streamed pools and poll the rest.
 */
async function poolRound(now: number): Promise<void> {
  if (pools.size === 0 || !reader?.getPoolVaultsBatch || !reader.getTokenAmountsBatch) return;
  for (const [mint, p] of pools) if (now > p.until) dropPool(mint);
  const toRead = new Map<string, { mint: string; quoteMint: string }>();
  for (const [mint, p] of pools) {
    if (p.vaults === null) toRead.set(p.address, { mint, quoteMint: WRAPPED_SOL_MINT });
    else {
      const since = poolCoveredSince(mint, p, now);
      // Streamed and read since its subscriptions began: the stream carries it.
      if (since !== null && p.readAt !== null && p.readAt >= since)
        poolTape.confirmStreamed(mint, since, now);
      else toRead.set(p.address, { mint, quoteMint: WRAPPED_SOL_MINT });
    }
  }
  if (toRead.size === 0) return;
  // The pool accounts first (their vaults and virtual reserve), then the vaults' balances.
  const accounts = await reader.getPoolVaultsBatch(toRead);
  stats.readCalls += Math.ceil(toRead.size / 100);
  const vaultsOf = new Map<string, PoolVaults>();
  for (const [address, { mint }] of toRead) {
    const p = pools.get(mint);
    const vaults = accounts.get(address);
    if (!p) continue;
    if (vaults === null && p.vaults === null) {
      // No pool account there (yet). A coin without one for POOL_MISS_LIMIT rounds has none.
      p.misses += 1;
      if (p.misses >= POOL_MISS_LIMIT) {
        dropPool(mint, false);
        if (noPool.size >= MAX_DONE) noPool.clear();
        noPool.add(mint);
      }
      continue;
    }
    if (!vaults || vaults === "failed") continue;
    if (p.vaults === null) {
      p.vaults = vaults;
      watchPool(mint, p, now);
    }
    p.virtualQuote = vaults.virtualQuote;
    vaultsOf.set(mint, p.vaults);
  }
  if (vaultsOf.size === 0) return;
  const amounts = await reader.getTokenAmountsBatch([...vaultsOf.values()].flatMap((v) => [v.base, v.quote]));
  stats.readCalls += Math.ceil((vaultsOf.size * 2) / 100);
  for (const [mint, vaults] of vaultsOf) {
    const p = pools.get(mint);
    const base = amounts.get(vaults.base);
    const quote = amounts.get(vaults.quote);
    if (!p || typeof base !== "number" || typeof quote !== "number") continue;
    p.base = base;
    p.quote = quote;
    // Stamped with when the read went out, as the curves' reads are.
    recordPool(mint, p, now, "read");
    p.readAt = now;
  }
}

/**
 * Takes up the day's stream spend a previous process recorded (the scan heartbeat's
 * curveTape.streamCreditsToday, written `at`), when it is from today (UTC) and above what this
 * process has counted. The pace (overStreamPace) counted from zero after every deploy, so each one
 * - several a day - handed the stream its whole share of the day again: past its pace and paused
 * at 18:00, it resumed at once after an 18:05 deploy and could spend that share a second time.
 */
export function seedCurveStreamSpend(creditsToday: number, at: Date, now = Date.now()): void {
  if (!(Number.isFinite(creditsToday) && creditsToday > 0)) return;
  const today = new Date(now).toISOString().slice(0, 10);
  if (at.toISOString().slice(0, 10) !== today || at.getTime() > now) return;
  rollDay(now);
  // streamCredits is 2 credits per 0.1 MB: back to the bytes it was figured from.
  dayStreamBytes = Math.max(dayStreamBytes, (creditsToday / 2) * 100_000);
}

/** Visible for tests: forgets everything. */
export function resetCurveTape(): void {
  for (const mint of [...followed.keys()]) tape.forget(mint);
  followed.clear();
  for (const mint of [...pools.keys()]) dropPool(mint, false);
  done.clear();
  noPool.clear();
  idleDropped.clear();
  paused = false;
  poolsPaused = false;
  day = "";
  dayStreamBytes = 0;
  stats = { updates: 0, bytes: 0, readCalls: 0, curvesRead: 0, polled: 0, seeded: 0, poolUpdates: 0 };
}
