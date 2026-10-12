import { createLogger } from "../logger.js";
import { PUMP_TOTAL_SUPPLY } from "../curation/tradeFlow.js";
import type { TokenLookupOptions } from "../datasources/dexscreener.js";
import type { GeckoTerminalClient } from "../datasources/geckoterminal.js";
import type { JupiterClient } from "../datasources/jupiter.js";
import type { CandidateToken } from "../types.js";
import type { LaunchQuoteSource } from "./refreshCandidates.js";

const logger = createLogger("live-launch-quotes");

/**
 * The most launches the backup is asked for a cycle: four of CoinGecko's 30-mint calls, the
 * newest first. Its free tier gives the scan's refresh 16 calls a minute in all.
 */
export const LIVE_LAUNCH_BACKUP_MAX = 120;

/** How long Jupiter gets before the backup is asked: it answers a batch in a few hundred ms. */
export const LIVE_LAUNCH_JUPITER_BUDGET_MS = 2_000;

/** What the live launch read did since the last takeStats(): mints asked, and who priced them. */
export interface LiveLaunchStats {
  asked: number;
  jupiter: number;
  backupAsked: number;
  backup: number;
  /** Asked, and priced by neither: the refresh falls back to DexScreener's reading for these. */
  unpriced: number;
}

/**
 * The young launches' live prices for the scan's band refresh (refreshAndFilterToBand's
 * liveLaunches): Jupiter first, seconds behind the market, then CoinGecko's on-chain API
 * (GeckoTerminal), about 20 s behind, for every launch Jupiter could not answer - its batch
 * failed, it rate-limited us or ran past the deadline. Whatever neither prices is read from
 * DexScreener as before, so a provider outage costs freshness, never the launch.
 *
 * A launch Jupiter answered without a price has not traded yet; CoinGecko has nothing for it
 * either, so it is not asked.
 */
export class LiveLaunchQuotes implements LaunchQuoteSource {
  private stats: LiveLaunchStats = { asked: 0, jupiter: 0, backupAsked: 0, backup: 0, unpriced: 0 };

  constructor(
    private readonly jupiter: Pick<JupiterClient, "getLaunches">,
    private readonly backup?: Pick<GeckoTerminalClient, "getTokensByAddresses">,
  ) {}

  takeStats(): LiveLaunchStats {
    const stats = this.stats;
    this.stats = { asked: 0, jupiter: 0, backupAsked: 0, backup: 0, unpriced: 0 };
    return stats;
  }

  async getLaunches(mintAddresses: string[], options: TokenLookupOptions = {}): Promise<CandidateToken[]> {
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;
    const remaining = () => (deadline === undefined ? undefined : Math.max(0, deadline - Date.now()));

    const jupiterFailed = new Set<string>();
    const fromJupiter = await this.jupiter
      .getLaunches(unique, {
        ...options,
        timeoutMs: Math.min(
          options.timeoutMs ?? LIVE_LAUNCH_JUPITER_BUDGET_MS,
          LIVE_LAUNCH_JUPITER_BUDGET_MS,
        ),
        deadlineMs: Math.min(
          options.deadlineMs ?? LIVE_LAUNCH_JUPITER_BUDGET_MS,
          LIVE_LAUNCH_JUPITER_BUDGET_MS,
        ),
        failed: jupiterFailed,
      })
      .catch((err: unknown) => {
        logger.warn("jupiter launch read failed - asking the backup", { error: String(err) });
        for (const mint of unique) jupiterFailed.add(mint);
        return [] as CandidateToken[];
      });
    const priced = new Map(fromJupiter.map((t) => [t.mintAddress, t]));

    // Callers pass the newest first, so the cap keeps the launches that matter most.
    const ask = unique.filter((m) => jupiterFailed.has(m) && !priced.has(m)).slice(0, LIVE_LAUNCH_BACKUP_MAX);
    let fromBackup: CandidateToken[] = [];
    const left = remaining();
    if (this.backup && ask.length > 0 && (left === undefined || left > 0)) {
      fromBackup = await this.backup
        .getTokensByAddresses(ask, {
          priority: true,
          timeoutMs: options.timeoutMs,
          retries: 0,
          deadlineMs: left,
          seenAt: options.seenAt,
        })
        .catch((err: unknown) => {
          logger.warn("backup launch read failed - DexScreener's readings stand", { error: String(err) });
          return [] as CandidateToken[];
        });
      for (const t of fromBackup) {
        if (!(t.priceUsd > 0) || priced.has(t.mintAddress)) continue;
        priced.set(t.mintAddress, onPumpSupply(t));
      }
    }

    const backupPriced = fromBackup.filter((t) => t.priceUsd > 0).length;
    this.stats.asked += unique.length;
    this.stats.jupiter += fromJupiter.length;
    this.stats.backupAsked += ask.length;
    this.stats.backup += backupPriced;
    this.stats.unpriced += unique.filter((m) => jupiterFailed.has(m) && !priced.has(m)).length;
    return [...priced.values()];
  }
}

/**
 * A Pump.fun coin's cap on the 1B supply DexScreener, Pump.fun and the Jupiter reading quote it
 * on, whatever supply the backup counted (notes/price-sourcing-audit-2026-10-12.md).
 */
function onPumpSupply(t: CandidateToken): CandidateToken {
  const pump = t.dexId === "pumpfun" || t.dexId === "pumpswap";
  return pump ? { ...t, marketCapUsd: t.priceUsd * PUMP_TOTAL_SUPPLY } : t;
}
