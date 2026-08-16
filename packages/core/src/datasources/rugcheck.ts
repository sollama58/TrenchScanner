import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";
import type { OnChainProfile } from "../types.js";

const logger = createLogger("rugcheck");

/** Subset of https://api.rugcheck.xyz/v1/tokens/{mint}/report we use. Public, no API key required. */
interface RugCheckReport {
  token?: { mintAuthority: string | null; freezeAuthority: string | null };
  creator?: string;
  creatorBalance?: number;
  totalHolders?: number;
  topHolders?: { pct: number; owner?: string; address: string }[];
  lpLockedPct?: number;
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
      const report = await fetchJson<RugCheckReport>(
        `${this.baseUrl}/tokens/${mintAddress}/report`,
        { timeoutMs: 10_000, retries: 1 },
      );
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

function toProfile(mintAddress: string, report: RugCheckReport): RugCheckProfile {
  const topHolders = report.topHolders ?? [];
  const top10HolderPct = topHolders
    .slice(0, TOP_N_FOR_CONCENTRATION)
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);

  // Dev wallet % is derived from topHolders: the creator only shows up there
  // if they still hold enough of the supply to rank in the top holder list.
  const devHolder = topHolders.find((h) => h.owner === report.creator || h.address === report.creator);

  return {
    mintAddress,
    holderCount: report.totalHolders,
    top10HolderPct: topHolders.length > 0 ? top10HolderPct : undefined,
    devWalletPct: devHolder?.pct,
    mintAuthorityActive: Boolean(report.token?.mintAuthority),
    freezeAuthorityActive: Boolean(report.token?.freezeAuthority),
    lpBurned: (report.lpLockedPct ?? 0) >= 95,
    riskScore: report.score_normalised ?? 0,
    riskFlags: (report.risks ?? []).map((r) => r.name),
  };
}
