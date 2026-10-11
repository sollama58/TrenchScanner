import { createLogger, type Env, type HeliusClient, type OnChainHolders } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("onchain-holders");

/**
 * The backup for RugCheck's holder list: a mint RugCheck has no report for (not indexed yet, or
 * RugCheck down or refusing us) gets its top-10 wallets read from the chain instead, so the safety
 * screen's concentration cut and the wallet checks a model call waits on
 * (CURATED_REQUIRE_WALLET_CHECKS) can run without RugCheck. Holder distribution is as mutable as
 * RugCheck's report, so an answer is reused for RUGCHECK_CACHE_TTL_MINUTES like one; failures
 * back off like the other on-chain lookups and are never cached.
 */
const cache = new Map<string, { at: number; holders: OnChainHolders }>();
const CACHE_MAX = 5_000;
const failureBackoff = new FailureBackoff();

/** Test hook. */
export function resetOnChainHolders(): void {
  cache.clear();
  failureBackoff.clear();
}

export async function resolveOnChainHolders(
  mintAddresses: string[],
  helius: HeliusClient,
  env: Env,
  now = Date.now(),
): Promise<Map<string, OnChainHolders>> {
  const out = new Map<string, OnChainHolders>();
  if (env.ONCHAIN_HOLDERS_MAX_PER_CYCLE === 0) return out;
  const ttl = env.RUGCHECK_CACHE_TTL_MINUTES * 60_000;
  const toRead: string[] = [];
  for (const mint of new Set(mintAddresses)) {
    const hit = cache.get(mint);
    if (hit && now - hit.at < ttl) out.set(mint, hit.holders);
    else if (!failureBackoff.blocked(mint, now) && toRead.length < env.ONCHAIN_HOLDERS_MAX_PER_CYCLE)
      toRead.push(mint);
    // Past the budget, a stale answer still beats none: the next cycle refreshes it.
    else if (hit) out.set(mint, hit.holders);
  }
  if (toRead.length === 0) return out;

  let results;
  try {
    results = await helius.getLargestHoldersBatch(toRead);
  } catch (err) {
    logger.warn("on-chain holder read failed", { mints: toRead.length, error: String(err) });
    for (const mint of toRead) failureBackoff.fail(mint, now);
    return out;
  }
  if (cache.size >= CACHE_MAX) {
    for (const [mint, entry] of cache) if (now - entry.at >= ttl) cache.delete(mint);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  let failed = 0;
  for (const mint of toRead) {
    const result = results.get(mint);
    if (result?.status === "found") {
      cache.set(mint, { at: now, holders: result.holders });
      failureBackoff.succeed(mint);
      out.set(mint, result.holders);
    } else {
      failed += 1;
      failureBackoff.fail(mint, now);
      const stale = cache.get(mint);
      if (stale) out.set(mint, stale.holders);
    }
  }
  failureBackoff.prune(now);
  if (failed > 0) logger.info("on-chain holder reads without an answer", { failed, asked: toRead.length });
  return out;
}
