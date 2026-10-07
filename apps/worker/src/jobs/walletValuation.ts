import {
  CASH_EQUIVALENT_MINTS,
  COMPLETE_BREAKDOWN_MAX,
  createLogger,
  type CandidateToken,
  type DexScreenerClient,
  type HeliusClient,
  type WalletHoldingsResult,
} from "@trenchscanner/core";

const logger = createLogger("wallet-valuation");

/**
 * The empty-wallet check's pricing, done without DAS: a wallet's token balances from two 1-credit
 * getTokenAccountsByOwner calls, priced off DexScreener (free), with decimals read from the mint
 * accounts (1 credit per 100 mints, cached for good).
 *
 * DAS searchAssets answers the same question in one call but bills 10 credits a wallet, and the
 * per-cycle budget that kept that affordable (10 wallets, one token a scan) left 94% of user
 * filter alerts showing "Not checked" (2026-10-06). This prices five wallets for one DAS call.
 *
 * Same contract as HeliusClient.getOtherHoldingsUsdBatch, so the cache and budget logic in
 * walletHoldings.ts sit on top of either: otherHoldingsUsd is a FLOOR of the wallet's non-cash,
 * non-gas holdings (unpriced tokens count as nothing), and perMintUsd carries each launch of
 * interest, zero included.
 */

/** How long a DexScreener quote (or "no usable pair") is reused. */
const PRICE_TTL_MS = 10 * 60_000;
/** Most mints priced per wallet; a wallet holding more is valued on these as a floor. */
export const MAX_PRICED_MINTS_PER_WALLET = 150;
/**
 * Most uncached mints sent to DexScreener per call - 10 of its 30-mint requests. Two calls a scan
 * (the cycle's and the backfill's) keep this well inside DexScreener's 300 requests a minute
 * alongside the scan's own refresh; the price cache does the rest.
 */
export const MAX_NEW_PRICES_PER_CALL = 300;
/** Fewest mints asked for before an all-empty answer is read as DexScreener misbehaving. */
const MIN_MINTS_FOR_PRICE_SANITY = 30;
/** Cache caps, so a long-lived worker's maps stay bounded. */
const MAX_PRICE_CACHE = 50_000;
const MAX_DECIMALS_CACHE = 100_000;

/**
 * What one whole token of a mint is worth for this signal, and the most a single holding of it
 * may count for.
 *
 * The cap is the guard against spam airdrops: a junk token with a quoted price and a vast
 * airdropped balance would otherwise make a shell wallet look rich - the wrong direction for a
 * safety signal. A holding counts for at most half the pool's liquidity (what it could actually
 * be sold into), or, on a Pump.fun curve that reports no liquidity, a twentieth of the market cap.
 * A token nobody traded in the last day counts for nothing.
 */
export interface MintQuote {
  priceUsd: number;
  capUsd: number;
}

const ZERO_QUOTE: MintQuote = { priceUsd: 0, capUsd: 0 };

export function quoteFromToken(
  token: Pick<CandidateToken, "priceUsd" | "liquidityUsd" | "marketCapUsd" | "volume24hUsd">,
): MintQuote {
  const price = token.priceUsd;
  if (!Number.isFinite(price) || price <= 0 || !((token.volume24hUsd ?? 0) > 0)) return ZERO_QUOTE;
  const liquidity = token.liquidityUsd ?? 0;
  const capUsd = liquidity > 0 ? liquidity / 2 : Math.max(0, token.marketCapUsd ?? 0) / 20;
  return capUsd > 0 ? { priceUsd: price, capUsd } : ZERO_QUOTE;
}

const priceCache = new Map<string, { quote: MintQuote; at: number }>();
const decimalsCache = new Map<string, number>();

/** Test hook: forget every cached price and decimals reading. */
export function resetValuationCaches(): void {
  priceCache.clear();
  decimalsCache.clear();
}

function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  // Maps iterate in insertion order, so the first keys are the oldest writes.
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

/** Remembers quotes the scan already holds - every in-band candidate's own price, for free. */
export function seedQuotes(tokens: Iterable<CandidateToken>, now: number = Date.now()): void {
  for (const t of tokens) {
    priceCache.delete(t.mintAddress);
    priceCache.set(t.mintAddress, { quote: quoteFromToken(t), at: now });
  }
  trimOldest(priceCache, MAX_PRICE_CACHE);
}

function cachedQuote(mint: string, now: number): MintQuote | undefined {
  const hit = priceCache.get(mint);
  if (!hit) return undefined;
  if (now - hit.at > PRICE_TTL_MS) {
    priceCache.delete(mint);
    return undefined;
  }
  return hit.quote;
}

export interface ValuationDeps {
  helius: Pick<HeliusClient, "getTokenBalancesBatch" | "getMintDecimals">;
  dexScreener: Pick<DexScreenerClient, "getTokensByAddresses">;
}

/**
 * A wallet this call could not finish this time - its mints didn't fit the per-call pricing
 * budget, or DexScreener didn't answer for them. Not a failure of the wallet: nothing is cached
 * and no back-off applies, so the next cycle simply tries again.
 */
export type ValuationResult = WalletHoldingsResult | { status: "deferred" };

/** A wallet's holdings with the order they should be priced in: launches of interest first. */
interface WalletPlan {
  address: string;
  /** Up to MAX_PRICED_MINTS_PER_WALLET non-cash mints, launches of interest first. */
  mints: [string, bigint][];
  truncated: boolean;
}

/**
 * Values each wallet's non-cash holdings - see the note at the top of this file.
 *
 * `minUsd` lets a wallet finish early: once the holdings outside the launches of interest are
 * already worth that much, the rest can't change the verdict, so they aren't priced (the result
 * is then a floor and marked incomplete, which the cache treats as good only for those launches).
 */
export async function valueWalletsFromBalances(
  addresses: string[],
  mintsOfInterest: Iterable<string>,
  deps: ValuationDeps,
  minUsd: number,
): Promise<Map<string, ValuationResult>> {
  const now = Date.now();
  const interesting = new Set(mintsOfInterest);
  const out = new Map<string, ValuationResult>();
  const unique = [...new Set(addresses)];
  if (unique.length === 0) return out;

  const balances = await deps.helius.getTokenBalancesBatch(unique);
  const plans: WalletPlan[] = [];
  for (const address of unique) {
    const reading = balances.get(address);
    if (!reading || reading.status !== "found") {
      out.set(address, { status: "failed" });
      continue;
    }
    const held = [...reading.balances].filter(([mint]) => !CASH_EQUIVALENT_MINTS.has(mint));
    // Launches of interest first (they must be valued for perMintUsd), then mints already priced
    // (free), then the rest.
    const rank = ([mint]: [string, bigint]) =>
      interesting.has(mint) ? 0 : cachedQuote(mint, now) !== undefined ? 1 : 2;
    held.sort((a, b) => rank(a) - rank(b));
    plans.push({
      address,
      mints: held.slice(0, MAX_PRICED_MINTS_PER_WALLET),
      // More mints than are priced, or more token accounts than one page read: a floor either way.
      truncated: held.length > MAX_PRICED_MINTS_PER_WALLET || reading.truncated === true,
    });
  }

  // Decimals for the holdings already priced, so the first pass below can value them.
  let newDecimals = await readMissingDecimals(plans, deps, now);

  // First pass on cached quotes only: wallets that already finish need no new prices.
  const pending = plans.filter((plan) => valuePlan(plan, interesting, minUsd, now) === null);

  // Uncached mints, wallet by wallet in the order given (callers pass the most urgent first),
  // until the per-call budget is spent. A wallet whose mints don't all fit is deferred whole.
  const toPrice = new Set<string>();
  for (const plan of pending) {
    const missing = plan.mints.map(([mint]) => mint).filter((m) => cachedQuote(m, now) === undefined);
    const fresh = missing.filter((m) => !toPrice.has(m));
    if (toPrice.size + fresh.length > MAX_NEW_PRICES_PER_CALL) continue;
    for (const m of fresh) toPrice.add(m);
  }

  if (toPrice.size > 0) {
    const failed = new Set<string>();
    const tokens = await deps.dexScreener.getTokensByAddresses([...toPrice], 3, {
      timeoutMs: 5_000,
      retries: 1,
      deadlineMs: 10_000,
      failed,
      // These are whatever else the holders own, most of it with no pair anywhere: an all-empty
      // answer is the usual case, not DexScreener going blank (the watchlist refresh decides that).
      mayBeUnindexed: true,
    });
    // Not one pair for a large request is a broken pipe, not a wallet full of dead coins: left
    // alone it would value every wallet at $0 and read every holder list as empty.
    if (toPrice.size >= MIN_MINTS_FOR_PRICE_SANITY && tokens.length === 0 && failed.size === 0) {
      logger.warn("dexscreener priced none of a large request - treating it as failed", {
        mints: toPrice.size,
      });
      for (const m of toPrice) failed.add(m);
    }
    const at = Date.now();
    const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
    for (const mint of toPrice) {
      if (failed.has(mint)) continue;
      const token = byMint.get(mint);
      // Absent from an answered batch: DexScreener has no pair, so it is worth nothing to us.
      priceCache.set(mint, { quote: token ? quoteFromToken(token) : ZERO_QUOTE, at });
    }
    trimOldest(priceCache, MAX_PRICE_CACHE);
  }

  // And for the holdings just priced.
  if (toPrice.size > 0) newDecimals += await readMissingDecimals(pending, deps, now);

  let deferred = 0;
  for (const plan of plans) {
    const result = valuePlan(plan, interesting, minUsd, now);
    if (result) {
      out.set(plan.address, result);
    } else {
      out.set(plan.address, { status: "deferred" });
      deferred += 1;
    }
  }
  logger.info("valued wallets from balances", {
    wallets: unique.length,
    newPrices: toPrice.size,
    newDecimals,
    deferred,
  });
  return out;
}

/**
 * Reads the decimals of every priced holding in `plans` that doesn't have them yet - immutable,
 * so cached for good. Returns how many it asked for.
 */
async function readMissingDecimals(plans: WalletPlan[], deps: ValuationDeps, now: number): Promise<number> {
  const need = new Set<string>();
  for (const plan of plans) {
    for (const [mint] of plan.mints) {
      const quote = cachedQuote(mint, now);
      if (quote && quote.priceUsd > 0 && !decimalsCache.has(mint)) need.add(mint);
    }
  }
  if (need.size === 0) return 0;
  const read = await deps.helius.getMintDecimals([...need]);
  for (const [mint, decimals] of read) decimalsCache.set(mint, decimals);
  trimOldest(decimalsCache, MAX_DECIMALS_CACHE);
  return need.size;
}

/**
 * The wallet's reading from what is known now, or null when it can't be finished yet: a holding
 * whose price or decimals are unknown, unless the holdings outside the launches of interest are
 * already worth `minUsd` without it.
 */
function valuePlan(
  plan: WalletPlan,
  interesting: Set<string>,
  minUsd: number,
  now: number,
): WalletHoldingsResult | null {
  let total = 0;
  let outsideInterest = 0;
  let unknown = false;
  let unknownInterest = false;
  const pricedByMint: Record<string, number> = {};
  for (const [mint, amount] of plan.mints) {
    const value = holdingUsd(mint, amount, now);
    if (value === undefined) {
      unknown = true;
      if (interesting.has(mint)) unknownInterest = true;
      continue;
    }
    if (value <= 0) continue;
    total += value;
    pricedByMint[mint] = (pricedByMint[mint] ?? 0) + value;
    if (!interesting.has(mint)) outsideInterest += value;
  }
  if (unknownInterest) return null;
  if (unknown && outsideInterest < minUsd) return null;

  const complete = !unknown && !plan.truncated && Object.keys(pricedByMint).length <= COMPLETE_BREAKDOWN_MAX;
  const perMintUsd: Record<string, number> = {};
  for (const mint of interesting) perMintUsd[mint] = 0;
  for (const [mint, usd] of Object.entries(pricedByMint)) {
    if (complete || interesting.has(mint)) perMintUsd[mint] = usd;
  }
  return { status: "found", otherHoldingsUsd: total, perMintUsd, complete };
}

/** USD a holding counts for: 0 when unpriceable, undefined when its price or decimals are unknown. */
function holdingUsd(mint: string, amount: bigint, now: number): number | undefined {
  const quote = cachedQuote(mint, now);
  if (quote === undefined) return undefined;
  if (quote.priceUsd <= 0) return 0;
  const decimals = decimalsCache.get(mint);
  if (decimals === undefined) return undefined;
  const whole = Number(amount) / 10 ** decimals;
  const value = Math.min(whole * quote.priceUsd, quote.capUsd);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
