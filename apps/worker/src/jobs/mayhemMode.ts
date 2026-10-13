import { SettledAnswers } from "./settledAnswers.js";
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

/** MayhemModeCache's answers, held in memory too - a mint's Mayhem flag never changes. */
export const settledMayhem = new SettledAnswers<boolean>(20_000);

/**
 * The Mayhem answers already known for `mintAddresses`, from memory and then MayhemModeCache - no
 * network call. A mint missing from the result has never been looked up successfully.
 */
export async function cachedMayhemMode(mintAddresses: string[]): Promise<Map<string, boolean>> {
  const unique = [...new Set(mintAddresses)];
  const known = settledMayhem.take(unique);
  const fromTable = unique.filter((mint) => !known.has(mint));
  const cached =
    fromTable.length === 0
      ? []
      : await prisma.mayhemModeCache.findMany({ where: { mintAddress: { in: fromTable } } });
  for (const row of cached) {
    known.set(row.mintAddress, row.isMayhemMode);
    settledMayhem.remember(row.mintAddress, row.isMayhemMode);
  }
  return known;
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

  for (const [mint, isMayhemMode] of await cachedMayhemMode(unique)) {
    result.set(mint, { status: "found", isMayhemMode });
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

  for (const row of toCache) settledMayhem.remember(row.mintAddress, row.isMayhemMode);
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

/** Mints already taken off the watchlist by this process - spares rewriting them every cycle. */
const ignoredMayhem = new SettledAnswers<true>(20_000);

/**
 * Records `mintAddresses` as Mayhem Mode tokens and takes them off the watchlist for good
 * (Token.ignoredAt; user decision 2026-10-13: once a coin is known to be Mayhem, nothing more is
 * read about it). Called with Pump.fun's own flag at discovery, which covers nearly every Mayhem
 * coin before it costs a single lookup, and with the scan's on-chain verdicts for the rest.
 * Pump.fun's flag matched the on-chain check on all 1,191 coins compared (notes/audit-2026-10-12).
 */
export async function ignoreMayhemMints(mintAddresses: string[]): Promise<number> {
  const known = ignoredMayhem.take(mintAddresses);
  const mints = [...new Set(mintAddresses)].filter((m) => !known.has(m));
  if (mints.length === 0) return 0;
  try {
    await prisma.mayhemModeCache.createMany({
      data: mints.map((mintAddress) => ({ mintAddress, isMayhemMode: true })),
      skipDuplicates: true,
    });
    const { count } = await prisma.token.updateMany({
      where: { mintAddress: { in: mints }, ignoredAt: null },
      data: { ignoredAt: new Date() },
    });
    for (const mint of mints) settledMayhem.remember(mint, true);
    // Only a mint whose row is now set aside is skipped next time: one discovered this cycle whose
    // row a late source has yet to write is retried with its next sighting.
    const setAside = await prisma.token.findMany({
      where: { mintAddress: { in: mints }, ignoredAt: { not: null } },
      select: { mintAddress: true },
    });
    for (const { mintAddress } of setAside) ignoredMayhem.remember(mintAddress, true);
    return count;
  } catch (err) {
    // Retried with the next sighting; until then the scan's screen rejects the coin as before.
    logger.warn("failed to set Mayhem tokens aside", { count: mints.length, error: String(err) });
    return 0;
  }
}
