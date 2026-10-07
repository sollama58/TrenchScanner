import { prisma, createLogger, type Env, type HeliusClient } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";
import { valueWalletsFromBalances, type ValuationDeps, type ValuationResult } from "./walletValuation.js";

const logger = createLogger("wallet-holdings");

/**
 * Wallets whose lookup FAILED, backed off before they are tried again - escalating from a couple
 * of minutes, see FailureBackoff. Same reasoning as the identical guard in walletFreshness.ts.
 */
const failureBackoff = new FailureBackoff();

/** Test hook: forget every recorded failure so the next call retries immediately. */
export function resetHoldingsFailureBackoff(): void {
  failureBackoff.clear();
}

/**
 * One candidate's top-10 holder list, carried with the mint it belongs to.
 *
 * The mint is the point: without it the resolver cannot tell which of a wallet's holdings is
 * "this launch" and so cannot take it back out of the total.
 */
export interface WalletGroup {
  mintAddress: string;
  addresses: string[];
}

export interface WalletHoldingsOptions {
  /** Cap on how many UNCACHED wallets are actually priced this call - see the env knob. */
  maxNewLookups?: number;
  /**
   * Only the first this-many groups may send lookups; the rest are answered from the cache alone.
   * Lets the scan wait on lookups for the candidates about to be decided on and leave the rest to
   * a pass behind the cycle - see the wallet stage in scanJob.ts.
   */
  lookupGroups?: number;
  /** Told how many lookups this call is about to send, before it sends them. */
  onLookups?: (count: number) => void;
  /**
   * Prices wallets from their token balances and DexScreener instead of DAS - see
   * walletValuation.ts. Used whenever given and WALLET_HOLDINGS_SOURCE is "balances".
   */
  valuation?: Pick<ValuationDeps, "dexScreener">;
}

/** Which route prices uncached wallets this call: the cheap balances one, or DAS. */
function holdingsSource(env: Env, opts: WalletHoldingsOptions): "balances" | "das" {
  return opts.valuation && env.WALLET_HOLDINGS_SOURCE === "balances" ? "balances" : "das";
}

/**
 * Uncached wallets priced per scan cycle on the configured route. The balances route costs about
 * 2 credits a wallet against DAS's 10, so it carries its own, larger budget.
 */
export function holdingsLookupBudget(env: Env): number {
  return env.WALLET_HOLDINGS_SOURCE === "balances"
    ? env.WALLET_BALANCE_LOOKUPS_PER_CYCLE
    : env.WALLET_HOLDINGS_MAX_LOOKUPS_PER_CYCLE;
}

/**
 * One wallet's reading: its non-cash holdings in total, plus what it holds of each launch it was
 * checked against.
 *
 * The two are kept apart because they are reused differently. The total is a property of the
 * wallet and serves every candidate it holds; the per-launch figure is what gets subtracted, and
 * only for the one launch whose holder list the wallet is currently on.
 */
export interface WalletHoldings {
  /** Non-cash, non-gas holdings in USD - a floor, and still including every launch. */
  otherHoldingsUsd: number;
  /** { mint: usd } for the launches this reading covers, zeroes included. */
  perMintUsd: Record<string, number>;
}

/**
 * Resolves "how much is this wallet holding in things that aren't cash or gas" for whole GROUPS
 * of wallets - one group per candidate's top-10 holder list, in priority order - in one cached,
 * budget-capped pass.
 *
 * Groups rather than a flat list, for exactly the reason walletFreshness.ts uses them:
 * computeEmptyPct is all-or-nothing, so a candidate with nine of ten wallets priced yields no
 * more information than one with none, having spent nine lookups to learn nothing. The budget is
 * therefore filled a whole group at a time, and a group that doesn't fit is skipped entirely so
 * its quota goes to a group that can actually be completed. Earlier groups win, so callers
 * should pass the candidates most likely to be curated first.
 *
 * The cache (WalletHoldingsCache) is TTL'd rather than permanent - a portfolio changes with every
 * trade, unlike the immutable first-transaction timestamp the freshness cache stores. That makes
 * its hit rate structurally lower; what still makes it pay is that the same wallets recur as top
 * holders across many launches inside any one TTL window.
 *
 * An address ABSENT from the returned map was never resolved - its group didn't fit the budget,
 * the lookup failed, or this endpoint doesn't serve the DAS API at all. computeEmptyPct reports
 * that as unknown rather than guessing.
 */
export async function resolveWalletHoldings(
  groups: WalletGroup[],
  helius: HeliusClient,
  env: Env,
  opts: WalletHoldingsOptions = {},
): Promise<Map<string, WalletHoldings>> {
  const now = Date.now();
  failureBackoff.prune(now);

  const result = new Map<string, WalletHoldings>();
  const unique = [...new Set(groups.flatMap((g) => g.addresses))];
  // Every launch in the cycle, so one reading of a wallet can answer for whichever of them it is
  // a top-10 holder of - see perMintUsd.
  const mintsOfInterest = new Set(groups.map((g) => g.mintAddress));
  if (unique.length === 0) return result;

  const freshCutoff = new Date(now - env.WALLET_HOLDINGS_CACHE_TTL_MINUTES * 60_000);
  const cached = await prisma.walletHoldingsCache.findMany({
    where: { address: { in: unique }, checkedAt: { gt: freshCutoff } },
  });
  const ownMints = mintsByWallet(groups);
  for (const row of cached) {
    const perMintUsd = asPerMintUsd(row.perMintUsd);
    if (row.breakdownComplete) {
      // Every priced holding is listed, so a launch missing from it counted for nothing in the
      // total - a known zero. This is what spares a recurring wallet a fresh 10-credit lookup
      // each time it turns up on another launch's holder list.
      for (const mint of ownMints.get(row.address) ?? []) perMintUsd[mint] ??= 0;
    } else if (!coversEveryRelevantMint(perMintUsd, ownMints.get(row.address))) {
      // A row can only answer for launches it was actually checked against. One written before
      // this wallet was seen holding today's candidate - or before the column existed at all -
      // would otherwise be subtracted against nothing and report the wallet as richer than it
      // is, which is the very bug this breakdown exists to fix. Re-fetch instead.
      continue;
    }
    result.set(row.address, { otherHoldingsUsd: row.otherHoldingsUsd, perMintUsd });
  }

  // An endpoint that doesn't serve DAS (or one stood down after an outage) can't answer anything
  // new, but what the cache already holds still answers: skipping lookups is the whole response.
  // Checked after the cache read, not before it - bailing first made every token's empty-wallet
  // share unknown for the whole stand-down, cached wallets included, and with
  // CURATED_REQUIRE_WALLET_CHECKS on that held up every curated decision for ten minutes.
  // The balances route is standard RPC plus DexScreener, so a DAS stand-down doesn't touch it.
  const source = holdingsSource(env, opts);
  const available = source === "balances" || helius.holdingsLookupAvailable;
  const budget = available ? (opts.maxNewLookups ?? Number.POSITIVE_INFINITY) : 0;
  const toFetch: string[] = [];
  const queued = new Set<string>();
  let skippedGroups = 0;
  const lookupGroups = opts.lookupGroups ?? Number.POSITIVE_INFINITY;
  for (const [index, group] of groups.entries()) {
    if (index >= lookupGroups) break;
    const needed = [...new Set(group.addresses)].filter((a) => !result.has(a) && !queued.has(a));
    if (needed.some((a) => failureBackoff.blocked(a, now))) {
      skippedGroups += 1;
      continue;
    }
    if (toFetch.length + needed.length > budget) {
      skippedGroups += 1;
      continue;
    }
    for (const address of needed) {
      toFetch.push(address);
      queued.add(address);
    }
  }

  const cacheHits = result.size;
  opts.onLookups?.(toFetch.length);
  if (toFetch.length === 0) {
    logger.info("resolved wallet holdings", {
      requested: unique.length,
      cached: cacheHits,
      fetched: 0,
      skippedGroups,
    });
    return result;
  }

  const fetched: Map<string, ValuationResult> =
    source === "balances" && opts.valuation
      ? await valueWalletsFromBalances(
          toFetch,
          mintsOfInterest,
          { helius, dexScreener: opts.valuation.dexScreener },
          env.WALLET_HOLDINGS_MIN_USD,
        )
      : await helius.getOtherHoldingsUsdBatch(toFetch, mintsOfInterest);

  // Only definitive answers are written. A failure is left uncached so a later cycle retries it,
  // and "unsupported" means the whole path is off - neither is a fact about the wallet.
  const resolved: {
    address: string;
    otherHoldingsUsd: number;
    perMintUsd: Record<string, number>;
    breakdownComplete: boolean;
  }[] = [];
  let failedCount = 0;
  let unsupported = 0;
  let deferred = 0;
  for (const address of toFetch) {
    const outcome = fetched.get(address) ?? { status: "failed" as const };
    if (outcome.status === "found") {
      failureBackoff.succeed(address);
      const perMintUsd = compactPerMint(outcome.perMintUsd, ownMints.get(address));
      result.set(address, { otherHoldingsUsd: outcome.otherHoldingsUsd, perMintUsd });
      resolved.push({
        address,
        otherHoldingsUsd: outcome.otherHoldingsUsd,
        perMintUsd,
        breakdownComplete: outcome.complete,
      });
    } else if (outcome.status === "unsupported") {
      unsupported += 1;
    } else if (outcome.status === "deferred") {
      // Ran out of this call's pricing budget - not the wallet's fault, so no back-off.
      deferred += 1;
    } else {
      failureBackoff.fail(address, now);
      failedCount += 1;
    }
  }

  if (resolved.length > 0) {
    try {
      // upsert, not createMany+skipDuplicates: unlike the activity cache this value CHANGES, so
      // an existing row is stale by definition and must be overwritten with the new reading.
      const checkedAt = new Date(now);
      await prisma.$transaction(
        resolved.map((row) =>
          prisma.walletHoldingsCache.upsert({
            where: { address: row.address },
            create: {
              address: row.address,
              otherHoldingsUsd: row.otherHoldingsUsd,
              perMintUsd: row.perMintUsd,
              breakdownComplete: row.breakdownComplete,
              checkedAt,
            },
            update: {
              otherHoldingsUsd: row.otherHoldingsUsd,
              perMintUsd: row.perMintUsd,
              breakdownComplete: row.breakdownComplete,
              checkedAt,
            },
          }),
        ),
      );
    } catch (err) {
      // Caching is a pure optimization - failing to persist only costs a re-fetch next cycle.
      logger.warn("failed to persist wallet holdings cache", {
        count: resolved.length,
        error: String(err),
      });
    }
  }

  logger.info("resolved wallet holdings", {
    requested: unique.length,
    cached: cacheHits,
    fetched: toFetch.length,
    newlyCached: resolved.length,
    failedWillRetryLater: failedCount,
    unsupported,
    deferred,
    source,
    skippedGroups,
  });

  return result;
}

/** Prisma hands a Json column back as unknown; narrow it without trusting its contents. */
function asPerMintUsd(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [mint, usd] of Object.entries(value as Record<string, unknown>)) {
    if (typeof usd === "number" && Number.isFinite(usd)) out[mint] = usd;
  }
  return out;
}

/**
 * Whether a cached reading can answer for every launch this wallet is a top-10 holder of in the
 * current cycle. A reading that predates the wallet's appearance on one of today's holder lists
 * has no figure to subtract for it, and subtracting nothing is exactly the overstatement the
 * breakdown exists to prevent.
 */
/** The launches each wallet is a listed holder of this cycle. */
function mintsByWallet(groups: WalletGroup[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const address of group.addresses) {
      let mints = out.get(address);
      if (!mints) out.set(address, (mints = new Set()));
      mints.add(group.mintAddress);
    }
  }
  return out;
}

/**
 * Drops the zero entries for launches the wallet isn't a listed holder of. The lookup seeds a
 * zero for every launch in the cycle (often 800+), and storing them all made each cache row tens
 * of kilobytes: WalletHoldingsCache was 263MB for under 2,000 wallets on 2026-10-04. What a row
 * needs is its own launches (zeroes included, so "holds none" stays a fact) and anything else it
 * actually holds; a zero for some other launch only saved a re-fetch in the rare case the wallet
 * later turns up on that launch's holder list without having bought any of it.
 */
export function compactPerMint(
  perMintUsd: Record<string, number>,
  own: Set<string> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [mint, usd] of Object.entries(perMintUsd)) {
    if (usd !== 0 || own?.has(mint)) out[mint] = usd;
  }
  return out;
}

function coversEveryRelevantMint(
  perMintUsd: Record<string, number>,
  ownMints: Iterable<string> | undefined,
): boolean {
  for (const mint of ownMints ?? []) {
    if (!(mint in perMintUsd)) return false;
  }
  return true;
}

/**
 * % of `addresses` holding less than `minUsd` in tokens that are neither cash, nor gas, nor
 * `mintAddress` itself - wallets that look like they exist only to hold this one launch. Returns
 * null (not 0) when there is nothing to check, so callers can tell "nothing to check" from
 * "checked, none empty".
 *
 * Excluding the launch is the whole point and was once missing, which inverted the signal. Every
 * address here is a top-10 holder of `mintAddress`, so it holds that token by definition - often
 * thousands of dollars of it. Counting that toward "other holdings" meant a wallet created for
 * this launch and holding nothing else scored as one of the richest wallets on the list, and the
 * percentage systematically understated how many wallets were shells.
 *
 * All-or-nothing, exactly like computeFreshPct: any address absent from the map makes the whole
 * answer null, because a percentage quoted over a top-10 list we only partly priced is a
 * fabricated number rather than a weak one. Those wallets retry on a later cycle.
 *
 * Note the asymmetry that remains in the value itself: measured holdings are a FLOOR (unpriced
 * assets count as zero - see getOtherHoldingsUsdBatch), so this percentage can overstate how
 * many wallets are empty, never understate. That direction is the safe one for a risk signal -
 * it errs toward flagging a token rather than vouching for it - but it does mean the number
 * should be read as "wallets we cannot see $25 of other holdings in", not "wallets that are
 * definitely empty".
 */
export function computeEmptyPct(
  addresses: string[],
  holdingsByAddress: Map<string, WalletHoldings>,
  minUsd: number,
  mintAddress: string,
): number | null {
  if (addresses.length === 0) return null;

  let emptyCount = 0;
  for (const address of addresses) {
    const holdings = holdingsByAddress.get(address);
    if (holdings === undefined) return null;
    // Absent means this reading never covered the launch, which resolveWalletHoldings refuses to
    // serve - so reaching here with a gap is a bug, not a wallet that holds none of it.
    const thisLaunch = holdings.perMintUsd[mintAddress];
    if (thisLaunch === undefined) return null;

    const besidesThisLaunch = holdings.otherHoldingsUsd - thisLaunch;
    if (besidesThisLaunch < minUsd) emptyCount += 1;
  }
  return (emptyCount / addresses.length) * 100;
}
