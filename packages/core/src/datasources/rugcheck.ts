import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import type { OnChainProfile } from "../types.js";

const logger = createLogger("rugcheck");

/** Subset of https://api.rugcheck.xyz/v1/tokens/{mint}/report we use. Public, no API key required. */
export interface RugCheckReport {
  token?: { mintAuthority: string | null; freezeAuthority: string | null };
  creator?: string;
  creatorBalance?: number;
  totalHolders?: number;
  topHolders?: { pct: number; owner?: string; address: string }[];
  // NOTE: lpLockedPct only appears at the top level of the /report/summary endpoint. The full
  // /report endpoint (what we call) nests it per-market instead - see toProfile() below.
  markets?: {
    pubkey: string;
    marketType?: string;
    lp?: { lpLockedPct?: number; baseUSD?: number; quoteUSD?: number };
  }[];
  score_normalised?: number;
  risks?: { name: string; level: string; description?: string }[];
}

export interface RugCheckProfile extends OnChainProfile {
  /** 0-100, higher = riskier (rugcheck's score_normalised). Undefined when the report has none - unknown, not safe. */
  riskScore?: number;
  riskFlags: string[];
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

/** RugCheck's marketType for a Pump.fun bonding curve and for the PumpSwap pool a token graduates into. */
const PUMP_MARKET_TYPES = new Set(["pump_fun", "pump_fun_amm"]);

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

export function toProfile(mintAddress: string, report: RugCheckReport): RugCheckProfile {
  const markets = report.markets ?? [];

  // The AMM pool's own authority shows up in topHolders holding whatever's currently in the
  // pool (e.g. 40%+ of supply right after a pump.fun graduation) - that's locked, protocol-owned
  // liquidity, not a wallet that can dump on holders, so it must be excluded from concentration
  // risk. Confirmed against live data: a market's `pubkey` is exactly the `owner` that shows up
  // on the pool's token holdings in topHolders.
  const poolAuthorities = new Set(markets.map((m) => m.pubkey));
  const realHolders = (report.topHolders ?? []).filter((h) => !poolAuthorities.has(h.owner ?? h.address));
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
    riskFlags.push("Creator identity unknown");
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
  const lpBurned = lpMarkets.length > 0 && lpMarkets.every((m) => (m.lp?.lpLockedPct ?? 0) >= 95);

  const top10Holders = realHolders.slice(0, TOP_N_FOR_CONCENTRATION);

  return {
    mintAddress,
    holderCount: report.totalHolders,
    top10HolderPct: realHolders.length > 0 ? top10HolderPct : undefined,
    devWalletPct: devHolder?.pct,
    creatorHolding:
      report.creator && typeof report.creatorBalance === "number" ? report.creatorBalance > 0 : undefined,
    // A report without its token block hasn't said either way: active until shown otherwise, as
    // the screen fails closed everywhere else, rather than read as renounced.
    mintAuthorityActive: report.token ? Boolean(report.token.mintAuthority) : true,
    freezeAuthorityActive: report.token ? Boolean(report.token.freezeAuthority) : true,
    lpBurned,
    riskScore: report.score_normalised,
    riskFlags,
    // Feeds the worker's wallet-freshness check (apps/worker/src/jobs/walletFreshness.ts) - a
    // wallet address per top-10 holder, already pool-excluded above. Falls back to `address` for
    // a holder entry that has no separate `owner` (RugCheck's shape allows both).
    // Deduplicated: RugCheck lists token accounts, and one owner with two accounts in the top ten
    // would otherwise be counted twice by both wallet checks.
    top10HolderAddresses: [...new Set(top10Holders.map((h) => h.owner ?? h.address))],
  };
}
