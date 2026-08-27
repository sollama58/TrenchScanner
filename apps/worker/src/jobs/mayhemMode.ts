import { prisma, createLogger, type HeliusClient, type MayhemModeResult } from "@trenchscanner/core";

const logger = createLogger("mayhem-mode");

/**
 * Resolves whether each mint was launched in Pump.fun's Mayhem Mode, in one batched, cached pass.
 * Mayhem tokens are rejected outright by the mandatory rug screen (see rugScreen.ts), so this
 * runs for every candidate every cycle - which is exactly why it has to be cheap.
 *
 * Both answers cache permanently (see MayhemModeCache in schema.prisma): Mayhem Mode is chosen at
 * launch and can be neither added to nor removed from an existing token, so in steady state this
 * only ever hits the network for mints discovered since the last cycle. A lookup that failed is
 * deliberately not cached - the rug screen rejects unverified mints, and a cached wrong answer
 * would be indistinguishable from a real one and would blacklist a legitimate token forever.
 */
export async function resolveMayhemMode(
  mintAddresses: string[],
  helius: HeliusClient,
): Promise<Map<string, MayhemModeResult>> {
  const unique = [...new Set(mintAddresses)];
  const result = new Map<string, MayhemModeResult>();
  if (unique.length === 0) return result;

  const cached = await prisma.mayhemModeCache.findMany({ where: { mintAddress: { in: unique } } });
  for (const row of cached) {
    result.set(row.mintAddress, { status: "found", isMayhemMode: row.isMayhemMode });
  }

  const uncached = unique.filter((mint) => !result.has(mint));
  if (uncached.length === 0) {
    logger.info("resolved mayhem mode", { requested: unique.length, cached: unique.length, fetched: 0 });
    return result;
  }

  const fetched = await helius.getMayhemModeBatch(uncached);

  const toCache: { mintAddress: string; isMayhemMode: boolean }[] = [];
  let failed = 0;
  for (const mint of uncached) {
    const outcome = fetched.get(mint) ?? { status: "failed" as const };
    result.set(mint, outcome);
    if (outcome.status === "found") {
      toCache.push({ mintAddress: mint, isMayhemMode: outcome.isMayhemMode });
    } else {
      failed += 1;
    }
  }

  if (toCache.length > 0) {
    try {
      await prisma.mayhemModeCache.createMany({ data: toCache, skipDuplicates: true });
    } catch (err) {
      // Caching is a pure optimization - losing it only costs a re-check next cycle.
      logger.warn("failed to persist mayhem mode cache", { count: toCache.length, error: String(err) });
    }
  }

  logger.info("resolved mayhem mode", {
    requested: unique.length,
    cached: unique.length - uncached.length,
    fetched: uncached.length,
    mayhemFound: toCache.filter((r) => r.isMayhemMode).length,
    failedWillRetryNextCycle: failed,
  });

  return result;
}
