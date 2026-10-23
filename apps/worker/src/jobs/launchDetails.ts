import {
  createLogger,
  fetchLaunchMetadata,
  forEachWithConcurrency,
  prisma,
  type DiscoveredCoin,
  type HeliusClient,
  type PumpFunClient,
} from "@trenchscanner/core";
import type { StreamEvent } from "../discovery/pumpPortalStream.js";

const logger = createLogger("launch-details");

/** Lookups waiting or running at once; launches past it are left as the stream gave them. */
const MAX_IN_FLIGHT = 300;
// Eight: with Pump.fun refusing, a read goes to the public IPFS gateways, a few seconds each.
const CONCURRENCY = 8;

export interface LaunchDetailStats {
  /** Streamed launches the coin list didn't carry, looked up. */
  asked: number;
  fromPumpFun: number;
  /** Pump.fun's single-coin read failed or had no such coin; the launch's metadata JSON answered. */
  fromMetadata: number;
  /** In-band coins whose URI came off the chain (DAS getAsset) and whose metadata JSON answered. */
  fromDas: number;
  /** Neither answered. */
  missing: number;
  /** Not looked up: too many already in flight. */
  dropped: number;
}

const emptyStats = (): LaunchDetailStats => ({
  asked: 0,
  fromPumpFun: 0,
  fromMetadata: 0,
  fromDas: 0,
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
  askedOnChain.clear();
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

/** In-band coins whose URI was read off the chain, each once (a miss stays a miss). */
const askedOnChain = new Set<string>();

export interface BandMetadataDeps {
  helius: Pick<HeliusClient, "getAssetMetadataUri">;
  /** Of `mints`, the coins whose description was never recorded (the Token row's is null). */
  pending?: (
    mints: readonly string[],
  ) => Promise<{ mintAddress: string; symbol: string | null; name: string | null }[]>;
  fetchMetadata?: typeof fetchLaunchMetadata;
}

/**
 * The description, socials and creator of in-band coins that have none recorded, through their
 * on-chain metadata URI (Helius DAS getAsset, 10 credits) and the launch JSON on the IPFS gateways.
 * Launches found through Jupiter's lists carry no URI, so with Pump.fun refusing (2026-10-22 on)
 * they reached the models with none of this (41 of 43 launch-detail asks a cycle "missing"). In-band
 * coins only, `perCycle` at most, each mint once (user decision 2026-10-23). Not awaited by the
 * scan: the rows are filled in when the answers land (addNewMintsToWatchlist's detail backfill).
 */
export async function fillBandMetadata(
  mints: readonly string[],
  perCycle: number,
  deps: BandMetadataDeps,
  save: (coins: DiscoveredCoin[]) => Promise<unknown>,
): Promise<void> {
  if (perCycle <= 0 || mints.length === 0) return;
  const fresh = [...new Set(mints)].filter((m) => !askedOnChain.has(m));
  if (fresh.length === 0) return;
  const pending = await (deps.pending ?? pendingTokens)(fresh);
  const todo = pending.slice(0, perCycle);
  if (todo.length === 0) return;
  if (askedOnChain.size + todo.length > ASKED_MAX) askedOnChain.clear();
  for (const t of todo) askedOnChain.add(t.mintAddress);
  stats.asked += todo.length;
  const fetchMetadata = deps.fetchMetadata ?? fetchLaunchMetadata;
  const found: DiscoveredCoin[] = [];
  await forEachWithConcurrency(todo, CONCURRENCY, async (token) => {
    const uri = await deps.helius.getAssetMetadataUri(token.mintAddress);
    if (uri === "failed") {
      // Nothing answered: ask again another cycle.
      askedOnChain.delete(token.mintAddress);
      stats.missing += 1;
      return;
    }
    if (uri === null) {
      stats.missing += 1;
      return;
    }
    try {
      const coin = await fetchMetadata(token.mintAddress, uri);
      if (!coin) {
        stats.missing += 1;
        return;
      }
      stats.fromDas += 1;
      found.push({ ...coin, symbol: token.symbol ?? coin.symbol, name: token.name ?? coin.name });
    } catch (err) {
      logger.debug("launch metadata read failed", { mint: token.mintAddress, error: String(err) });
      stats.missing += 1;
    }
  });
  if (found.length > 0) await save(found);
}

async function pendingTokens(mints: readonly string[]) {
  return prisma.token.findMany({
    where: { mintAddress: { in: [...mints] }, description: null },
    select: { mintAddress: true, symbol: true, name: true },
  });
}
