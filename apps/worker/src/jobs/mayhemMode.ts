import { prisma, createLogger, type HeliusClient, type MayhemModeResult } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("mayhem-mode");

/**
 * Mints whose Mayhem lookup FAILED, backed off before they are retried. Without it a mint the RPC
 * consistently chokes on cost a lookup every cycle forever - and, because the rug screen rejects
 * unverified mints, it was being rejected every one of those cycles anyway. Escalating from a
 * couple of minutes (see FailureBackoff): the screen rejects the mint for as long as it waits, so
 * one blip must not cost a fresh launch its first 20 minutes.
 */
const failureBackoff = new FailureBackoff();
/**
 * A mint the RPC doesn't see yet (confirmed-commitment lag on a seconds-old token) is a different
 * wait: the account appears within a slot or two, and a token that reached the band this fast is
 * exactly one worth re-checking on the next cycle.
 */
const MINT_PENDING_BACKOFF_MINUTES = 1;

/** Test hook: forget every recorded failure so the next call retries immediately. */
export function resetMayhemFailureBackoff(): void {
  failureBackoff.clear();
}

/**
 * Resolves whether each mint was launched in Pump.fun's Mayhem Mode, in one batched, cached pass.
 * Mayhem tokens are rejected outright by the mandatory rug screen (see rugScreen.ts).
 *
 * Called only for candidates that already clear every OTHER rug-screen condition (see
 * passesLocalRugScreen and its use in scanJob.ts): this is the one screen condition that costs a
 * network call, and a mint already failing on authorities or LP is rejected whatever the answer
 * would have been. On a Pump.fun-heavy watchlist that filter removes most first-sight lookups.
 *
 * Both answers cache permanently (see MayhemModeCache in schema.prisma): Mayhem Mode is chosen at
 * launch and can be neither added to nor removed from an existing token, so in steady state this
 * only ever hits the network for mints discovered since the last cycle. A lookup that failed is
 * deliberately not cached - the rug screen rejects unverified mints, and a cached wrong answer
 * would be indistinguishable from a real one and would blacklist a legitimate token forever - it
 * is instead backed off briefly, so retrying stays cheap without becoming permanent.
 */
export async function resolveMayhemMode(
  mintAddresses: string[],
  helius: HeliusClient,
): Promise<Map<string, MayhemModeResult>> {
  const unique = [...new Set(mintAddresses)];
  const result = new Map<string, MayhemModeResult>();
  if (unique.length === 0) return result;

  const now = Date.now();
  failureBackoff.prune(now);

  const cached = await prisma.mayhemModeCache.findMany({ where: { mintAddress: { in: unique } } });
  for (const row of cached) {
    result.set(row.mintAddress, { status: "found", isMayhemMode: row.isMayhemMode });
  }

  // A backed-off mint reports "failed" without a call - the same answer it would have produced,
  // at no cost. The rug screen rejects it either way until the backoff lapses.
  let backedOff = 0;
  for (const mint of unique) {
    if (!result.has(mint) && failureBackoff.blocked(mint, now)) {
      result.set(mint, { status: "failed" });
      backedOff += 1;
    }
  }

  const uncached = unique.filter((mint) => !result.has(mint));
  if (uncached.length === 0) {
    logger.info("resolved mayhem mode", {
      requested: unique.length,
      cached: unique.length - backedOff,
      fetched: 0,
      backedOff,
    });
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
      failureBackoff.succeed(mint);
    } else {
      failureBackoff.fail(mint, now, outcome.mintPending ? MINT_PENDING_BACKOFF_MINUTES : undefined);
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
    cached: unique.length - uncached.length - backedOff,
    fetched: uncached.length,
    backedOff,
    mayhemFound: toCache.filter((r) => r.isMayhemMode).length,
    failedWillRetryLater: failed,
  });

  return result;
}
