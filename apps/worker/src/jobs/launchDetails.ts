import {
  createLogger,
  fetchLaunchMetadata,
  forEachWithConcurrency,
  type DiscoveredCoin,
  type PumpFunClient,
} from "@trenchscanner/core";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";

const logger = createLogger("launch-details");

/** Lookups waiting or running at once; launches past it are left as the stream gave them. */
const MAX_IN_FLIGHT = 300;
const CONCURRENCY = 4;

export interface LaunchDetailStats {
  /** Streamed launches the coin list didn't carry, looked up. */
  asked: number;
  fromPumpFun: number;
  /** Pump.fun's single-coin read failed or had no such coin; the launch's metadata JSON answered. */
  fromMetadata: number;
  /** Neither answered. */
  missing: number;
  /** Not looked up: too many already in flight. */
  dropped: number;
}

const emptyStats = (): LaunchDetailStats => ({
  asked: 0,
  fromPumpFun: 0,
  fromMetadata: 0,
  missing: 0,
  dropped: 0,
});
let stats = emptyStats();
let inFlight = 0;

/** Each mint is read once: the stream repeats, and Jupiter's lists show a young coin minute after minute. */
const asked = new Set<string>();
const ASKED_MAX = 20_000;

/** Test hook. */
export function resetLaunchDetails(): void {
  asked.clear();
  inFlight = 0;
  stats = emptyStats();
}

/** The counts since the last call, for the scan's heartbeat. */
export function takeLaunchDetailStats(): LaunchDetailStats {
  const out = stats;
  stats = emptyStats();
  return out;
}

/**
 * The description, socials and image of launches the PumpPortal stream reported but Pump.fun's
 * coin list didn't, read one coin at a time, then handed to `save`. The stream gives a mint, a
 * name and a ticker; the description and socials (hasDescription, hasTwitter, the Narrative
 * inputs) came only from the list. When the list was blocked (2026-10-14 from about 21:00 UTC,
 * a Cloudflare challenge on every page) every new launch reached the models without them, and
 * calls fell to about a fifth over the next hours as older coins aged out.
 *
 * Pump.fun's single-coin endpoint first (the same fields the list gives), the launch's IPFS
 * metadata JSON when that fails. Not awaited by the scan: a row the cycle creates bare is filled
 * in when the answer lands (addNewMintsToWatchlist backfills a missing description). On a healthy
 * list this is only the launches of the last few seconds before the cycle read it.
 */
export async function fillLaunchDetails(
  launches: StreamEvent[],
  pumpFun: Pick<PumpFunClient, "coinDetails">,
  save: (coins: DiscoveredCoin[]) => Promise<unknown>,
  fetchMetadata: typeof fetchLaunchMetadata = fetchLaunchMetadata,
): Promise<void> {
  const byMint = new Map<string, StreamEvent>();
  for (const e of launches)
    if (e.kind === "create" && !asked.has(e.mintAddress)) byMint.set(e.mintAddress, e);
  let todo = [...byMint.values()];
  const room = Math.max(0, MAX_IN_FLIGHT - inFlight);
  if (todo.length > room) {
    stats.dropped += todo.length - room;
    todo = todo.slice(0, room);
  }
  if (todo.length === 0) return;
  if (asked.size + todo.length > ASKED_MAX) asked.clear();
  for (const launch of todo) asked.add(launch.mintAddress);
  inFlight += todo.length;
  stats.asked += todo.length;
  const found: DiscoveredCoin[] = [];
  try {
    await forEachWithConcurrency(todo, CONCURRENCY, async (launch) => {
      try {
        const coin = await lookUp(launch, pumpFun, fetchMetadata);
        if (coin) found.push(coin);
        else stats.missing += 1;
      } finally {
        inFlight -= 1;
      }
    });
  } finally {
    if (found.length > 0) await save(found);
  }
}

async function lookUp(
  launch: StreamEvent,
  pumpFun: Pick<PumpFunClient, "coinDetails">,
  fetchMetadata: typeof fetchLaunchMetadata,
): Promise<DiscoveredCoin | null> {
  try {
    const coin = await pumpFun.coinDetails(launch.mintAddress);
    if (coin) {
      stats.fromPumpFun += 1;
      return coin;
    }
  } catch (err) {
    logger.debug("pump.fun coin read failed - trying the launch metadata", {
      mint: launch.mintAddress,
      error: String(err),
    });
  }
  if (!launch.metadataUri) return null;
  try {
    const coin = await fetchMetadata(launch.mintAddress, launch.metadataUri);
    if (!coin) return null;
    stats.fromMetadata += 1;
    // The stream's own ticker and name win: they are what every other source of this mint reports.
    return { ...coin, symbol: launch.symbol ?? coin.symbol, name: launch.name ?? coin.name };
  } catch {
    return null;
  }
}
