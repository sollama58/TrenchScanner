import { SettledAnswers } from "./settledAnswers.js";
import {
  createLogger,
  HeliusClient,
  type Env,
  type PumpLaunch,
  type PumpLaunchResult,
} from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("pump-launch");

/**
 * Whether each mint is a proven Pump.fun launch (core's pumpLaunch.ts), for candidates the safety
 * screen would otherwise reject on LP or authorities: RugCheck lists only the markets it indexed,
 * and for a curve quoted in another Pump.fun coin rather than SOL it listed only the Meteora side
 * pools others opened, which read as unlocked LP (DiveEYHTf3...pump, 2026-10-16).
 *
 * Both answers are final once the mint is visible - the curve is created with the mint, by the
 * same instruction - so they are held for the life of the process. A failed read is backed off,
 * never remembered, and leaves the screen's answer as the other sources gave it (failing closed).
 *
 * Rate limits: the read is one getMultipleAccounts per 50 mints, asked only for coins failing on
 * LP or authorities and only once per coin. A mint Helius gives no answer for is asked of each
 * backup in turn (pumpLaunchReaders): the paid CHAIN_BACKUP_RPC_URLS, SOLANA_RPC_URL,
 * TRADING_BACKUP_RPC_URL, then a free public endpoint.
 */
const settled = new SettledAnswers<PumpLaunch | null>(20_000);
const failureBackoff = new FailureBackoff(2, 20, { helius: true });
/** A mint the RPC doesn't see yet is checked again next cycle, as the Mayhem lookup does. */
const MINT_PENDING_BACKOFF_MINUTES = 1;

/** Test hook: a fresh process's state. */
export function resetPumpLaunchState(): void {
  settled.clear();
  failureBackoff.clear();
}

type PumpLaunchReader = Pick<HeliusClient, "getPumpLaunchBatch">;

/** The backups after Helius, in the order they are asked, each endpoint once. */
export function pumpLaunchBackupUrls(
  env: Pick<Env, "CHAIN_BACKUP_RPC_URLS" | "SOLANA_RPC_URL" | "TRADING_BACKUP_RPC_URL">,
): string[] {
  const urls = [
    ...env.CHAIN_BACKUP_RPC_URLS.split(","),
    env.SOLANA_RPC_URL,
    env.TRADING_BACKUP_RPC_URL,
    PUBLIC_RPC,
  ].map((u) => u.trim());
  return [...new Set(urls.filter((u) => /^https:\/\//.test(u)))];
}

/** The last resort: free, rate limited, but another provider than every paid one above. */
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export function pumpLaunchBackups(
  env: Pick<Env, "CHAIN_BACKUP_RPC_URLS" | "SOLANA_RPC_URL" | "TRADING_BACKUP_RPC_URL">,
): PumpLaunchReader[] {
  return pumpLaunchBackupUrls(env).map((rpcUrl) => new HeliusClient({ rpcUrl }));
}

export async function resolvePumpLaunches(
  mintAddresses: string[],
  helius: PumpLaunchReader,
  backups: readonly PumpLaunchReader[] = [],
  now = Date.now(),
): Promise<Map<string, PumpLaunchResult>> {
  const unique = [...new Set(mintAddresses)];
  const result = new Map<string, PumpLaunchResult>();
  if (unique.length === 0) return result;

  for (const [mint, launch] of settled.take(unique)) result.set(mint, { status: "found", launch });
  failureBackoff.prune(now);
  const toFetch = unique.filter((mint) => !result.has(mint) && !failureBackoff.blocked(mint, now));
  if (toFetch.length === 0) return result;

  // Each reader is asked only for what the ones before it gave no answer for. A mint the RPC
  // doesn't see yet is no outage: the next cycle asks again.
  const fetched = new Map<string, PumpLaunchResult>();
  let fromBackups = 0;
  for (const [i, reader] of [helius, ...backups].entries()) {
    const ask = toFetch.filter((mint) => {
      const got = fetched.get(mint);
      return !got || (got.status === "failed" && !got.mintPending);
    });
    if (ask.length === 0) break;
    try {
      const answers = await reader.getPumpLaunchBatch(ask);
      for (const [mint, answer] of answers) {
        if (answer.status === "found" || !fetched.has(mint)) fetched.set(mint, answer);
        if (answer.status === "found" && i > 0) fromBackups += 1;
      }
    } catch (err) {
      logger.warn("pump launch lookup failed", { reader: i, count: ask.length, error: String(err) });
    }
  }
  let proven = 0;
  for (const mint of toFetch) {
    const outcome = fetched.get(mint) ?? { status: "failed" as const };
    result.set(mint, outcome);
    if (outcome.status === "found") {
      settled.remember(mint, outcome.launch);
      failureBackoff.succeed(mint);
      if (outcome.launch) proven += 1;
    } else {
      failureBackoff.fail(mint, now, outcome.mintPending ? MINT_PENDING_BACKOFF_MINUTES : undefined);
    }
  }
  logger.info("resolved pump launches", {
    requested: unique.length,
    fetched: toFetch.length,
    fromBackups,
    proven,
  });
  return result;
}
