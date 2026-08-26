import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";
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
  markets?: { pubkey: string; lp?: { lpLockedPct?: number } }[];
  score_normalised?: number;
  risks?: { name: string; level: string; description?: string }[];
}

export interface RugCheckProfile extends OnChainProfile {
  riskScore: number; // 0-100, higher = riskier (rugcheck's score_normalised)
  riskFlags: string[];
}

export interface RugCheckClientOptions {
  baseUrl?: string;
}

const TOP_N_FOR_CONCENTRATION = 10;

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
   */
  async getProfile(mintAddress: string): Promise<RugCheckProfile | null> {
    try {
      const report = await fetchJson<RugCheckReport>(`${this.baseUrl}/tokens/${mintAddress}/report`, {
        timeoutMs: 10_000,
        retries: 1,
      });
      return toProfile(mintAddress, report);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Not yet indexed by RugCheck (very new token) - treat as unknown, not an error.
        logger.debug("no rugcheck report yet", { mintAddress });
        return null;
      }
      logger.warn("failed to fetch rugcheck report", { mintAddress, error: String(err) });
      return null;
    }
  }

  /** Fetches profiles for many mints with limited concurrency to be a polite API citizen. */
  async getProfiles(mintAddresses: string[], concurrency = 5): Promise<Map<string, RugCheckProfile>> {
    const results = new Map<string, RugCheckProfile>();
    const queue = [...mintAddresses];

    async function worker(client: RugCheckClient) {
      while (queue.length > 0) {
        const mint = queue.shift();
        if (!mint) continue;
        const profile = await client.getProfile(mint);
        if (profile) results.set(mint, profile);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker(this)));
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
  const devHolder = realHolders.find((h) => h.owner === report.creator || h.address === report.creator);
  const riskFlags = (report.risks ?? []).map((r) => r.name);
  if (!report.creator) {
    riskFlags.push("Creator identity unknown");
  }

  // lpLockedPct lives per-market on the full /report endpoint (unlike /report/summary, which
  // has it at the top level). Most tokens have exactly one market; if there are several, treat
  // the LP as burned only when every one of them is - a single unlocked pool is still a rug vector.
  const lpBurned = markets.length > 0 && markets.every((m) => (m.lp?.lpLockedPct ?? 0) >= 95);

  const top10Holders = realHolders.slice(0, TOP_N_FOR_CONCENTRATION);

  return {
    mintAddress,
    holderCount: report.totalHolders,
    top10HolderPct: realHolders.length > 0 ? top10HolderPct : undefined,
    devWalletPct: devHolder?.pct,
    mintAuthorityActive: Boolean(report.token?.mintAuthority),
    freezeAuthorityActive: Boolean(report.token?.freezeAuthority),
    lpBurned,
    riskScore: report.score_normalised ?? 0,
    riskFlags,
    // Feeds HeliusClient.getFreshWalletPct (see scanJob.ts) - a wallet address per top-10 holder,
    // already pool-excluded above. Falls back to `address` for a holder entry that has no
    // separate `owner` (RugCheck's shape allows both).
    top10HolderAddresses: top10Holders.map((h) => h.owner ?? h.address),
  };
}
