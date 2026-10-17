import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import type { OnChainProfile } from "../types.js";
import { CEX_FUNDED_TOP_N } from "../wallets/linkedWallets.js";
import { venueAccountsOf } from "../venueAccounts.js";
import { FEE_HOLDERS } from "../stonksFees.js";
import type { OnChainHolders } from "./onChainHolders.js";

const logger = createLogger("rugcheck");

/** Subset of https://api.rugcheck.xyz/v1/tokens/{mint}/report we use. Public, no API key required. */
export interface RugCheckReport {
  token?: { mintAuthority: string | null; freezeAuthority: string | null };
  creator?: string;
  creatorBalance?: number;
  totalHolders?: number;
  topHolders?: { pct: number; owner?: string; address: string }[];
  /** The launchpad RugCheck names, when it does ("stonkfun", "pump_fun"...). */
  launchpad?: string | null;
  // NOTE: lpLockedPct only appears at the top level of the /report/summary endpoint. The full
  // /report endpoint (what we call) nests it per-market instead - see toProfile() below.
  markets?: {
    pubkey: string;
    marketType?: string;
    /** The market's two vault token accounts. */
    liquidityA?: string;
    liquidityB?: string;
    lp?: { lpLockedPct?: number; baseUSD?: number; quoteUSD?: number };
  }[];
  score_normalised?: number;
  risks?: { name: string; level: string; description?: string }[];
}

export interface RugCheckProfile extends OnChainProfile {
  /** 0-100, higher = riskier (rugcheck's score_normalised). Undefined when the report has none - unknown, not safe. */
  riskScore?: number;
  riskFlags: string[];
  /**
   * The market-excluded holders behind top10HolderPct, owner and % of supply, up to
   * CEX_FUNDED_TOP_N: at least one more than the ten, enough to recompute the top ten without one
   * of them (withoutVenueHolder), and the list the exchange-funded share reads. Absent on
   * profiles cached before it existed, or when the shares can't be trusted.
   */
  topHolderShares?: { owner: string; pct: number }[];
  /** The creator's wallet, as RugCheck names it. Absent on profiles cached before it was kept. */
  creator?: string;
  /**
   * False when the report listed no market at all, so lpBurned (false) is not a reading: a report
   * fetched in a launch's first seconds has no Pump.fun market yet. The scan then takes the venue's
   * own answer, as the chain fallback does, and the report is re-read every minute (audit
   * 2026-10-14, L2 H2 / L3 L3). Absent otherwise.
   */
  marketsListed?: false;
  /**
   * The LP lock judged on Raydium LaunchLab's own markets alone (RAYDIUM_LAUNCHLAB_MARKET_TYPES:
   * the curve, and the CPMM pool a LaunchLab coin migrates into), as lpBurned is on a Pump.fun
   * coin's own markets: what the scan reads for a Stonks coin, whose side pools others open are
   * no more its holders' exit than a Pump.fun coin's. Absent when no such market is listed, and on
   * profiles cached before it existed.
   */
  launchLabLpBurned?: boolean;
}

/**
 * The profile without the token's own pool among its holders. RugCheck leaves out the pools its
 * markets list names, but in the first minutes after a Pump.fun coin graduates the report can
 * predate the new PumpSwap pool, which then reads as a holder (its vault's owner is the pool's own
 * address) and pushes the top ten over the safety screen's concentration cut. `venueAddress` is
 * the pool DexScreener reports for the coin. Returns the profile unchanged when the pool is not
 * among its holders or the shares to recompute from are missing.
 */
export function withoutVenueHolder(
  cached: RugCheckProfile,
  venueAddress: string | undefined,
): RugCheckProfile {
  // Profiles cached before largestHolderPct existed still carry the shares it comes from.
  const profile =
    cached.largestHolderPct === undefined && cached.topHolderShares?.length
      ? { ...cached, largestHolderPct: largestHolderShare(cached.topHolderShares) }
      : cached;
  const shares = profile.topHolderShares;
  if (!venueAddress || !shares?.some((h) => h.owner === venueAddress)) return profile;
  const rest = shares.filter((h) => h.owner !== venueAddress);
  const top = rest.slice(0, TOP_N_FOR_CONCENTRATION);
  return {
    ...profile,
    top10HolderPct: top.length > 0 ? top.reduce((sum, h) => sum + h.pct, 0) : undefined,
    largestHolderPct: largestHolderShare(rest),
    top10HolderAddresses: [...new Set(top.map((h) => h.owner))],
    topHolderShares: rest,
  };
}

/**
 * The profile with its holder figures (top-10 share, largest holder, the top-10 wallets, the
 * shares behind them, the dev's share) taken from the chain's reading instead of RugCheck's list.
 * RugCheck can serve the same holder list for hours: on 2026-10-16 6vs4o...pump's report still
 * listed a wallet at 15% more than an hour after it had sold every token, and the coin failed the
 * largest-holder cut on it. Everything else on the profile (authorities, LP, risk, holder count)
 * stays RugCheck's. Returns the profile unchanged without a trustworthy reading.
 */
export function withChainHolders(
  profile: RugCheckProfile,
  holders: Pick<OnChainHolders, "top10HolderPct" | "largestHolderPct" | "topHolderShares"> | undefined,
): RugCheckProfile {
  const shares = holders?.topHolderShares;
  if (!holders || !shares?.length || holders.top10HolderPct === undefined) return profile;
  const top = shares.slice(0, TOP_N_FOR_CONCENTRATION);
  const creator = profile.creator ? shares.find((h) => h.owner === profile.creator) : undefined;
  return {
    ...profile,
    top10HolderPct: holders.top10HolderPct,
    largestHolderPct: holders.largestHolderPct,
    top10HolderAddresses: [...new Set(top.map((h) => h.owner))],
    topHolderShares: shares.slice(0, Math.max(TOP_N_FOR_CONCENTRATION + 1, CEX_FUNDED_TOP_N)),
    devWalletPct: creator?.pct,
  };
}

/**
 * The largest single holder's share of supply: one owner's several token accounts summed, since
 * RugCheck lists accounts. Undefined for an empty list.
 */
export function largestHolderShare(shares: readonly { owner: string; pct: number }[]): number | undefined {
  const byOwner = new Map<string, number>();
  for (const h of shares) byOwner.set(h.owner, (byOwner.get(h.owner) ?? 0) + h.pct);
  return byOwner.size > 0 ? Math.max(...byOwner.values()) : undefined;
}

/**
 * A definitive "here is the report" / "RugCheck has no report for this mint" / "the lookup itself
 * failed". The third must never be cached - see RugCheckCache in schema.prisma.
 */
export type RugCheckProfileResult =
  { status: "found"; profile: RugCheckProfile } | { status: "absent" } | { status: "failed" };

export interface RugCheckClientOptions {
  baseUrl?: string;
}

const TOP_N_FOR_CONCENTRATION = 10;
/** A top-10 share past this (100%, plus rounding) means the report's shares don't share one supply. */
const MAX_TOP10_SHARE_PCT = 100.5;

/** The risk flag toProfile adds when RugCheck names no creator (rugScreen.ts treats it as critical). */
export const CREATOR_UNKNOWN_FLAG = "Creator identity unknown";

/** RugCheck's marketType for a Pump.fun bonding curve and for the PumpSwap pool a token graduates into. */
const PUMP_MARKET_TYPES = new Set(["pump_fun", "pump_fun_amm"]);

/**
 * RugCheck's marketType for a Raydium LaunchLab curve (Stonks' launchpad) and for the CPMM pool its
 * coins migrate into. Only read for a coin known to be from a LaunchLab launchpad: anyone can open
 * a CPMM pool for any coin.
 */
const RAYDIUM_LAUNCHLAB_MARKET_TYPES = new Set(["raydium_launchlab", "raydium_cpmm"]);

/** A non-Pump.fun token's pools holding less than this share of its pooled liquidity don't count for the LP check. */
const SIDE_POOL_MAX_SHARE = 0.05;

export class RugCheckClient {
  private readonly baseUrl: string;

  constructor(options: RugCheckClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.rugcheck.xyz/v1";
  }

  /**
   * Fetches on-chain risk data for a single mint: authority status, LP lock
   * percentage, holder concentration, and dev wallet balance. Returns null
   * (rather than throwing) on failure so the scan loop can treat "unknown"
   * distinctly from "failed the screen" - callers should decide how to
   * handle missing data (v1 treats unknown as fail-closed, see rugScreen.ts).
   *
   * Prefer getProfileResult when the answer is going to be cached: this collapses "RugCheck has
   * no report" and "the request failed" into the same null, and caching the second as if it were
   * the first would persist a transport blip for the whole TTL.
   */
  async getProfile(mintAddress: string): Promise<RugCheckProfile | null> {
    const result = await this.getProfileResult(mintAddress);
    return result.status === "found" ? result.profile : null;
  }

  /**
   * Same lookup, with "no report exists" and "the lookup failed" kept apart. Matches the shape
   * HeliusClient already uses for its cached lookups (EarliestActivityResult and friends) for the
   * same reason: only a definitive answer is safe to write to a cache.
   */
  async getProfileResult(mintAddress: string): Promise<RugCheckProfileResult> {
    try {
      const report = await fetchJson<RugCheckReport>(`${this.baseUrl}/tokens/${mintAddress}/report`, {
        timeoutMs: 10_000,
        retries: 1,
      });
      return { status: "found", profile: toProfile(mintAddress, report) };
    } catch (err) {
      // Not yet indexed by RugCheck (very new token) - a real answer, not an error. RugCheck
      // answers that with a 400 {"error":"not found"} now (checked 2026-10-07: 25 of the 30
      // newest Pump.fun mints), not the 404 it used to. A 400 is the same answer every time for
      // the same mint, so it counts as absent too: read as a failure it was never cached, and
      // every unindexed in-band mint went back to RugCheck on every 30-second cycle.
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
        logger.debug("no rugcheck report yet", { mintAddress, status: err.status });
        return { status: "absent" };
      }
      logger.warn("failed to fetch rugcheck report", { mintAddress, error: String(err) });
      return { status: "failed" };
    }
  }

  /** Fetches profiles for many mints with limited concurrency to be a polite API citizen.
   *  Deduped first (same pattern as DexScreenerClient.getTokensByAddresses) so a caller that
   *  hands back the same mint twice in one list doesn't cost a duplicate outbound request. */
  async getProfiles(mintAddresses: string[], concurrency = 5): Promise<Map<string, RugCheckProfile>> {
    const results = new Map<string, RugCheckProfile>();
    for (const [mint, result] of await this.getProfileResults(mintAddresses, concurrency)) {
      if (result.status === "found") results.set(mint, result.profile);
    }
    return results;
  }

  /**
   * getProfiles, keeping "no report" and "lookup failed" apart for every mint. With `deadlineMs`,
   * mints still queued when it passes are not requested and get no entry at all (the ones in
   * flight finish): they were never asked, so they are neither an answer nor a failure, and a
   * caller must not back them off as one. `sink` receives each answer as it lands, for a caller
   * that stops waiting earlier.
   */
  async getProfileResults(
    mintAddresses: string[],
    concurrency = 5,
    opts: { deadlineMs?: number; sink?: Map<string, RugCheckProfileResult> } = {},
  ): Promise<Map<string, RugCheckProfileResult>> {
    const unique = [...new Set(mintAddresses)];
    const results = new Map<string, RugCheckProfileResult>();
    const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
    await forEachWithConcurrency(unique, concurrency, async (mint) => {
      if (Date.now() >= deadline) return;
      const result = await this.getProfileResult(mint);
      results.set(mint, result);
      opts.sink?.set(mint, result);
    });
    return results;
  }
}

/**
 * The owner RugCheck reports for a token account that no longer exists: the System Program's
 * address, with the account's last balance still attached (seen at 6% of supply on a two-hour-old
 * coin, 2026-10-12). It is nobody's wallet. Kept in the list, its stale share inflated the top-10
 * concentration, and as a "holder" it read as a years-old, never-fresh wallet in the denominator
 * of the fresh-wallet share - one per report, since both wallet checks deduplicate owners.
 */
const CLOSED_ACCOUNT_OWNER = "11111111111111111111111111111111";

export function toProfile(mintAddress: string, report: RugCheckReport): RugCheckProfile {
  const markets = report.markets ?? [];

  // The AMM pool's own authority shows up in topHolders holding whatever's currently in the
  // pool (e.g. 40%+ of supply right after a pump.fun graduation) - that's locked, protocol-owned
  // liquidity, not a wallet that can dump on holders, so it must be excluded from concentration
  // risk. Confirmed against live data: a market's `pubkey` is exactly the `owner` that shows up
  // on the pool's token holdings in topHolders.
  const poolAuthorities = new Set(markets.map((m) => m.pubkey));
  // Not every program owns its vault from the market's own address: Raydium LaunchLab (Stonks'
  // curve) holds every curve's tokens under one shared authority, which read as a single holder
  // of ~96% of supply. The vault token accounts themselves are the market's, whoever owns them.
  const poolVaults = new Set(
    markets.flatMap((m) => [m.liquidityA, m.liquidityB]).filter((a): a is string => typeof a === "string"),
  );
  // The markets list is not every venue the coin has had: a graduated Pump.fun coin's report lists
  // its PumpSwap pool and not the bonding curve, which can still hold a fifth of supply (seen
  // 2026-10-16 on 2bQcQ...pump: the curve at 22% read as the largest holder and failed the screen),
  // and a report from a coin's first minutes lists no market at all. The venue accounts derived
  // from the mint (venueAccountsOf) are left out whatever the list says.
  const venueAccounts = venueAccountsOf(mintAddress);
  const realHolders = (report.topHolders ?? []).filter((h) => {
    const owner = h.owner ?? h.address;
    return (
      !poolAuthorities.has(owner) &&
      !poolVaults.has(h.address) &&
      !venueAccounts.has(owner) &&
      // Stonks' fee wallet holds swept transfer fees, not a bag, on any coin (stonksFees.ts).
      !FEE_HOLDERS.has(owner) &&
      owner !== CLOSED_ACCOUNT_OWNER
    );
  });
  const top10HolderPct = realHolders
    .slice(0, TOP_N_FOR_CONCENTRATION)
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);

  // Dev wallet % is derived from the (pool-excluded) holder list: the creator only shows up
  // there if they still hold enough of the supply to rank in the top holder list. Note this
  // means devWalletPct is undefined in two very different situations - (a) the creator holds a
  // negligible amount (safe, common, expected) and (b) we have no creator identity at all
  // (genuinely unknown, not safe). Only (b) should fail the rug screen closed; conflating the
  // two would reject the common, benign case. (b) is surfaced as a critical risk flag instead of
  // via devWalletPct itself, since a bare `undefined` can't carry that distinction - see
  // CRITICAL_RISK_FLAGS in rugScreen.ts.
  // Guarded: with no creator, `h.owner === report.creator` matched any holder lacking an owner
  // (undefined === undefined) and reported that holder's bag as the dev's.
  const devHolder = report.creator
    ? realHolders.find((h) => h.owner === report.creator || h.address === report.creator)
    : undefined;
  const riskFlags = (report.risks ?? []).map((r) => r.name);
  if (!report.creator) {
    riskFlags.push(CREATOR_UNKNOWN_FLAG);
  }

  // lpLockedPct lives per-market on the full /report endpoint (unlike /report/summary, which
  // has it at the top level). A Pump.fun token's own venue - its bonding curve, then the PumpSwap
  // pool it graduates into - is what holders sell into, and its liquidity is locked by the
  // protocol; that is the market the rug question is about. Other pools are opened later by
  // anyone (Meteora DLMM and DAMM pools mostly, a few dollars each to begin with), and RugCheck
  // reads every one of them as 0% locked: a DLMM pool has no LP token at all, and a DAMM pool's
  // LP belongs to whoever added the liquidity - pulling it takes that person's own money out,
  // not the holders' exit. Judging every market rejected tokens the moment someone opened a side
  // pool - which happens to the runners: 42% of a sample of event tokens that later failed this
  // way had doubled, against 13% overall (notes/safety-precheck-review-2026-10-06.md). So when a
  // Pump.fun market exists only Pump.fun markets count. Any other token (a Meteora or Raydium
  // launchpad coin the trending feed found) gets the same treatment by size: pools holding under
  // SIDE_POOL_MAX_SHARE of its pooled liquidity are ignored - in practice a few dollars of dust in
  // pools nobody trades - and every remaining pool must be locked, as before.
  const pumpMarkets = markets.filter(
    (m) => m.marketType !== undefined && PUMP_MARKET_TYPES.has(m.marketType),
  );
  const poolUsd = (m: (typeof markets)[number]) => (m.lp?.baseUSD ?? 0) + (m.lp?.quoteUSD ?? 0);
  const totalPoolUsd = markets.reduce((sum, m) => sum + poolUsd(m), 0);
  const lpMarkets =
    pumpMarkets.length > 0
      ? pumpMarkets
      : totalPoolUsd > 0
        ? markets.filter((m) => poolUsd(m) >= SIDE_POOL_MAX_SHARE * totalPoolUsd)
        : markets;
  const locked = (m: (typeof markets)[number]) => (m.lp?.lpLockedPct ?? 0) >= 95;
  const lpBurned = lpMarkets.length > 0 && lpMarkets.every(locked);
  const launchLabMarkets = markets.filter(
    (m) => m.marketType !== undefined && RAYDIUM_LAUNCHLAB_MARKET_TYPES.has(m.marketType),
  );

  const top10Holders = realHolders.slice(0, TOP_N_FOR_CONCENTRATION);

  // Shares of one supply cannot sum past 100. A report whose top ten do (seen at 120% in
  // production) mixes denominators, so neither the sum nor any one holder's share from it can be
  // trusted: both read as unknown rather than as an impossible concentration.
  const sharesConsistent = top10HolderPct <= MAX_TOP10_SHARE_PCT;

  return {
    mintAddress,
    // 0 holders is an unindexed list, not a token nobody holds: as a count it made both holder
    // growth windows read exactly -100%.
    holderCount:
      typeof report.totalHolders === "number" && report.totalHolders > 0 ? report.totalHolders : undefined,
    top10HolderPct: realHolders.length > 0 && sharesConsistent ? top10HolderPct : undefined,
    largestHolderPct: sharesConsistent
      ? largestHolderShare(realHolders.map((h) => ({ owner: h.owner ?? h.address, pct: h.pct ?? 0 })))
      : undefined,
    devWalletPct: sharesConsistent ? devHolder?.pct : undefined,
    creatorHolding:
      report.creator && typeof report.creatorBalance === "number" ? report.creatorBalance > 0 : undefined,
    // A report without its token block hasn't said either way: active until shown otherwise, as
    // the screen fails closed everywhere else, rather than read as renounced.
    mintAuthorityActive: report.token ? Boolean(report.token.mintAuthority) : true,
    freezeAuthorityActive: report.token ? Boolean(report.token.freezeAuthority) : true,
    lpBurned,
    riskScore: report.score_normalised,
    riskFlags,
    ...(markets.length === 0 ? { marketsListed: false as const } : {}),
    ...(launchLabMarkets.length > 0 ? { launchLabLpBurned: launchLabMarkets.every(locked) } : {}),
    // For the linked-wallets reading (whose holders the creator funded, or shares a funder with).
    ...(report.creator ? { creator: report.creator } : {}),
    // Feeds the worker's wallet-freshness check (apps/worker/src/jobs/walletFreshness.ts) - a
    // wallet address per top-10 holder, already pool-excluded above. Falls back to `address` for
    // a holder entry that has no separate `owner` (RugCheck's shape allows both).
    // Deduplicated: RugCheck lists token accounts, and one owner with two accounts in the top ten
    // would otherwise be counted twice by both wallet checks.
    top10HolderAddresses: [...new Set(top10Holders.map((h) => h.owner ?? h.address))],
    ...(sharesConsistent && realHolders.length > 0
      ? {
          topHolderShares: realHolders
            .slice(0, Math.max(TOP_N_FOR_CONCENTRATION + 1, CEX_FUNDED_TOP_N))
            .map((h) => ({ owner: h.owner ?? h.address, pct: h.pct ?? 0 })),
        }
      : {}),
  };
}
