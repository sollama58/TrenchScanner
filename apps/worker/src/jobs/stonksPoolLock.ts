import { createLogger, type HeliusClient } from "@trenchscanner/core";
import { SettledAnswers } from "./settledAnswers.js";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("stonks-pool-lock");

/**
 * Whether a graduated Stonks coin's Raydium CPMM pool has its LP burned or locked, read from the
 * chain (core's HeliusClient.getCpmmLpLockedBatch). RugCheck lists only SOL-quoted markets: a coin
 * whose curve was quoted in a tokenized stock graduates into a pool paired with that stock, which
 * RugCheck never lists, and the coin was judged on the Meteora side pools others opened in SOL -
 * 0% locked, so "LP not burned" (DER1K...WTsZ against SAMA4, 2026-10-19: its CPMM pool held 85%
 * of its liquidity, LP 100% in Raydium's lock).
 *
 * Asked only for a Stonks coin trading on Raydium whose RugCheck report lists no LaunchLab market
 * (or that has no report). Locked LP stays locked, so a locked answer is held for the life of the
 * process; any other answer is read again after UNLOCKED_RECHECK_MINUTES, and a failed read is
 * backed off. Rate limits: a handful of RPC calls per pool, once per pool.
 */
const settled = new SettledAnswers<true>(5_000);
const failureBackoff = new FailureBackoff();
const UNLOCKED_RECHECK_MINUTES = 10;
/** The share of the pool's LP that must be burned or locked, as RugCheck's lpLockedPct cut (rugcheck.ts). */
const LOCKED_SHARE = 0.95;

/** Test hook: a fresh process's state. */
export function resetStonksPoolLockState(): void {
  settled.clear();
  failureBackoff.clear();
}

/** The mints whose pool's LP was read burned or locked. A mint absent from the set is unproven. */
export async function resolveStonksPoolLocks(
  candidates: readonly { mintAddress: string; pairAddress: string }[],
  helius: Pick<HeliusClient, "getCpmmLpLockedBatch">,
  now = Date.now(),
): Promise<Set<string>> {
  const locked = new Set<string>();
  if (candidates.length === 0) return locked;
  const key = (c: { mintAddress: string; pairAddress: string }) => `${c.mintAddress}:${c.pairAddress}`;
  const known = settled.take(candidates.map(key));
  failureBackoff.prune(now);
  const toFetch = new Map<string, string>();
  for (const c of candidates) {
    if (known.has(key(c))) locked.add(c.mintAddress);
    else if (!failureBackoff.blocked(key(c), now)) toFetch.set(c.pairAddress, c.mintAddress);
  }
  if (toFetch.size === 0) return locked;

  let answers: Map<string, number | null | "failed">;
  try {
    answers = await helius.getCpmmLpLockedBatch(toFetch);
  } catch (err) {
    logger.warn("stonks pool lock lookup failed", { count: toFetch.size, error: String(err) });
    answers = new Map();
  }
  for (const [pool, mint] of toFetch) {
    const k = `${mint}:${pool}`;
    const share = answers.get(pool) ?? "failed";
    if (share === "failed") {
      failureBackoff.fail(k, now);
    } else if (share !== null && share >= LOCKED_SHARE) {
      settled.remember(k, true);
      failureBackoff.succeed(k);
      locked.add(mint);
    } else {
      failureBackoff.fail(k, now, UNLOCKED_RECHECK_MINUTES);
    }
  }
  logger.info("resolved stonks pool locks", {
    requested: candidates.length,
    fetched: toFetch.size,
    locked: locked.size,
  });
  return locked;
}
