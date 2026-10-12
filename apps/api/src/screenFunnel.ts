import { prisma } from "@trenchscanner/core";

/** Longest window /stats/screen-funnel answers: Token(firstSeenAt) rows, ~1,500 an hour. */
export const SCREEN_FUNNEL_MAX_HOURS = 6;

export interface ScreenFunnelRow {
  mint: string;
  symbol: string | null;
  discoverySource: string | null;
  firstSeenAt: Date;
  /** Last time a market lookup (or a Pump.fun revival) answered for the mint; null = never priced. */
  lastLiveAt: Date | null;
  lastMcapUsd: number | null;
  /** Scan snapshots stored for it: one per cycle it was in (or near) the band and scanned. */
  snapshots: number;
  firstSnapshotAt: Date | null;
  firstSnapshotMcapUsd: number | null;
  /** What the screen said on the first snapshot: why a coin that passed later waited. */
  firstPassed: boolean | null;
  firstReasons: string[] | null;
  /** The first passing snapshot; null = never passed. With the first snapshot, how long the screen held it back. */
  firstPassAt: Date | null;
  firstPassMcapUsd: number | null;
  /** Highest market cap on any of its snapshots. */
  maxSnapshotMcapUsd: number | null;
  latestPassed: boolean | null;
  latestReasons: string[] | null;
  everPassed: boolean;
}

/**
 * Every token first seen in the last `hours`, with how far down the funnel it got: priced at all
 * (lastLiveAt), scanned in the band (snapshots), and what the safety screen said. The admin screen
 * report only counts these; this is the per-mint list a script joins against an outside source
 * (Pump.fun's own market-cap history, say) to tell "never reached the band" from "never looked at".
 * One index probe per token through Token(firstSeenAt) and TokenSnapshot(tokenId, takenAt).
 */
export async function buildScreenFunnel(hours: number) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await prisma.$queryRaw<
    {
      mint: string;
      symbol: string | null;
      discovery_source: string | null;
      first_seen_at: Date;
      last_live_at: Date | null;
      last_mcap_usd: number | null;
      snapshots: bigint;
      first_snapshot_at: Date | null;
      first_snapshot_mcap: number | null;
      first_passed: boolean | null;
      first_reasons: string[] | null;
      first_pass_at: Date | null;
      first_pass_mcap: number | null;
      max_mcap: number | null;
      latest_passed: boolean | null;
      latest_reasons: string[] | null;
      ever_passed: boolean;
    }[]
  >`
    SELECT t."mintAddress" AS mint, t.symbol, t."discoverySource" AS discovery_source,
           t."firstSeenAt" AS first_seen_at, t."lastLiveAt" AS last_live_at,
           t."lastMcapUsd" AS last_mcap_usd,
           agg.n AS snapshots, first_s."takenAt" AS first_snapshot_at,
           first_s."marketCapUsd" AS first_snapshot_mcap,
           first_s."rugScreenPassed" AS first_passed, first_s."rugScreenReasons" AS first_reasons,
           pass_s."takenAt" AS first_pass_at, pass_s."marketCapUsd" AS first_pass_mcap,
           agg.max_mcap,
           last_s."rugScreenPassed" AS latest_passed, last_s."rugScreenReasons" AS latest_reasons,
           COALESCE(agg.ever_passed, false) AS ever_passed
    FROM "Token" t
    CROSS JOIN LATERAL (
      SELECT count(*) AS n, bool_or("rugScreenPassed") AS ever_passed, max("marketCapUsd") AS max_mcap
      FROM "TokenSnapshot" WHERE "tokenId" = t.id
    ) agg
    LEFT JOIN LATERAL (
      SELECT "takenAt", "marketCapUsd", "rugScreenPassed", "rugScreenReasons" FROM "TokenSnapshot"
      WHERE "tokenId" = t.id
      ORDER BY "takenAt" ASC LIMIT 1
    ) first_s ON true
    LEFT JOIN LATERAL (
      SELECT "takenAt", "marketCapUsd" FROM "TokenSnapshot"
      WHERE "tokenId" = t.id AND "rugScreenPassed" AND agg.ever_passed
      ORDER BY "takenAt" ASC LIMIT 1
    ) pass_s ON true
    LEFT JOIN LATERAL (
      SELECT "rugScreenPassed", "rugScreenReasons" FROM "TokenSnapshot" WHERE "tokenId" = t.id
      ORDER BY "takenAt" DESC LIMIT 1
    ) last_s ON true
    WHERE t."firstSeenAt" > ${since}
    ORDER BY t."firstSeenAt" DESC`;

  const tokens: ScreenFunnelRow[] = rows.map((r) => ({
    mint: r.mint,
    symbol: r.symbol,
    discoverySource: r.discovery_source,
    firstSeenAt: r.first_seen_at,
    lastLiveAt: r.last_live_at,
    lastMcapUsd: r.last_mcap_usd,
    snapshots: Number(r.snapshots),
    firstSnapshotAt: r.first_snapshot_at,
    firstSnapshotMcapUsd: r.first_snapshot_mcap,
    firstPassed: r.first_passed,
    firstReasons: r.first_reasons,
    firstPassAt: r.first_pass_at,
    firstPassMcapUsd: r.first_pass_mcap,
    maxSnapshotMcapUsd: r.max_mcap,
    latestPassed: r.latest_passed,
    latestReasons: r.latest_reasons,
    everPassed: r.ever_passed,
  }));
  return {
    window: { hours, since },
    discovered: tokens.length,
    priced: tokens.filter((t) => t.lastLiveAt !== null).length,
    screened: tokens.filter((t) => t.snapshots > 0).length,
    everPassed: tokens.filter((t) => t.everPassed).length,
    tokens,
  };
}
