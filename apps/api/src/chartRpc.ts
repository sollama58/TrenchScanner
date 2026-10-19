import { createLogger, HeliusClient, type PoolVaults } from "@trenchscanner/core";
import { chartHealth, type ChartHealth } from "./chartHealth.js";

const logger = createLogger("chart-rpc");

/**
 * The live tail's RPC reads (liveCurve.ts), on two routes (user ask 2026-10-19: "can we have
 * multiple data sources?"). Helius alone priced every chart off the stream, and SOLANA_RPC_URL was
 * never asked (audit item 13): a Helius outage or a 429 pause froze every chart that wasn't on the
 * socket. Now whatever Helius gave no answer for is asked once more of SOLANA_RPC_URL, when it is
 * set and is another endpoint. Each answer that came back stands; only the "failed" ones go again.
 */

export type ChartReader = Pick<
  HeliusClient,
  | "getCurveStatesBatch"
  | "getPoolVaultsBatch"
  | "getTokenAmountsBatch"
  | "findLaunchLabPool"
  | "findCpmmPoolVaults"
>;

/** The second route for chart reads: SOLANA_RPC_URL when set and not the Helius endpoint itself. */
export function chartBackupRpcUrl(
  solanaRpcUrl: string | undefined,
  heliusApiKey: string | undefined,
): string | null {
  const url = solanaRpcUrl?.trim();
  if (!url) return null;
  // The same key on another spelling of the URL is the same limits: no second route.
  if (heliusApiKey && url.includes(heliusApiKey)) return null;
  return url;
}

/**
 * The chart's reader: Helius on its own 429 lane (a pause the wallet modal or fee reads ran into
 * no longer holds the chart's prices: audit item 10), then the backup for what Helius didn't answer.
 * Null with neither.
 */
export function chartReaderFor(
  heliusApiKey: string | undefined,
  solanaRpcUrl: string | undefined,
): ChartReader | null {
  const primary = heliusApiKey ? new HeliusClient({ apiKey: heliusApiKey, pauseLane: "chart" }) : null;
  const backupUrl = chartBackupRpcUrl(solanaRpcUrl, heliusApiKey);
  const backup = backupUrl ? new HeliusClient({ rpcUrl: backupUrl, pauseLane: "chart" }) : null;
  if (primary) return withBackupRoute(primary, backup);
  return backup;
}

type Batch<K, V> = Map<K, V | "failed">;

/** Reads `keys` on `primary`, then whatever failed there on `backup`, once. */
async function both<V>(
  keys: string[],
  read: (r: ChartReader, keys: string[]) => Promise<Batch<string, V>>,
  primary: ChartReader,
  backup: ChartReader | null,
  health: ChartHealth,
): Promise<Batch<string, V>> {
  const out = await read(primary, keys).catch((err) => {
    logger.warn("chart read failed on helius", { error: String(err) });
    return new Map<string, V | "failed">(keys.map((k) => [k, "failed"]));
  });
  const failed = keys.filter((k) => (out.get(k) ?? "failed") === "failed");
  if (failed.length === 0) return out;
  health.recordHeliusReadFailures(failed.length);
  if (!backup) return out;
  const again = await read(backup, failed).catch((err) => {
    logger.warn("chart read failed on the backup rpc", { error: String(err) });
    return new Map<string, V | "failed">();
  });
  let stillFailed = 0;
  for (const k of failed) {
    const v = again.get(k);
    if (v === undefined || v === "failed") stillFailed += 1;
    else out.set(k, v);
  }
  health.recordBackupRead(stillFailed, failed.length);
  return out;
}

/** `primary`'s reads, each retried once on `backup` for the keys it failed. */
export function withBackupRoute(
  primary: ChartReader,
  backup: ChartReader | null,
  health: ChartHealth = chartHealth(),
): ChartReader {
  const one = async <V>(read: (r: ChartReader) => Promise<V | "failed">): Promise<V | "failed"> => {
    const first = await read(primary).catch(() => "failed" as const);
    if (first !== "failed") return first;
    health.recordHeliusReadFailures(1);
    if (!backup) return first;
    const again = await read(backup).catch(() => "failed" as const);
    health.recordBackupRead(again === "failed" ? 1 : 0, 1);
    return again;
  };
  return {
    getCurveStatesBatch: (curves) =>
      both([...new Set(curves)], (r, keys) => r.getCurveStatesBatch(keys), primary, backup, health),
    getTokenAmountsBatch: (accounts) =>
      both([...new Set(accounts)], (r, keys) => r.getTokenAmountsBatch(keys), primary, backup, health),
    getPoolVaultsBatch: (pools) =>
      both<PoolVaults | null>(
        [...pools.keys()],
        (r, keys) => r.getPoolVaultsBatch(new Map(keys.map((k) => [k, pools.get(k)!]))),
        primary,
        backup,
        health,
      ),
    findLaunchLabPool: (mint) => one((r) => r.findLaunchLabPool(mint)),
    findCpmmPoolVaults: (mint, quoteMint) => one((r) => r.findCpmmPoolVaults(mint, quoteMint)),
  };
}
