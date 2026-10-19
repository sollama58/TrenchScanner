import { createLogger } from "./logger.js";
import { PUMP_SUPPLY_TOKENS } from "./wallets/tradeTape.js";

const logger = createLogger("mint-supply");

/**
 * Where a market cap comes from, everywhere: the coin's price times its supply now, read off its
 * mint account (user bug report 2026-10-19: the token chart, the top bar and the cards disagreed).
 * Pump.fun mints one billion tokens at launch, and burns take some out for good: on 2026-10-19
 * three graduated coins read 0.95B, 0.95B and 0.99B on chain, which DexScreener's and Jupiter's
 * market caps count, while Pump.fun's candles and coin API, the bonding-curve tail,
 * GeckoTerminal's fdv and the scan's own Pump.fun readings all priced on the launch billion, up
 * to ~5% high. Those launch-billion figures are put on the current supply through this module.
 */

/** A mint's supply in whole tokens (decimals applied), per mint asked; a mint missing had no answer. */
export interface MintSupplyReader {
  getMintSupplies(mints: string[]): Promise<Map<string, number>>;
}

/** Mint supplies as the readers use them: a mint missing from the answer has no reading yet. */
export interface MintSupplySource {
  /** `waitMs`: the longest to wait on a mint with no reading yet (the source's own default when omitted). */
  get(mints: readonly string[], waitMs?: number): Promise<Map<string, number>>;
}

export interface MintSupplyOptions {
  /** How long a reading is used as current. A burn moves the cap from the next read on. */
  ttlMs?: number;
  /** The longest a reader waits on a read; past it an older reading (or none) stands. */
  waitMs?: number;
  /** Mints kept; the least recently read go first. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Mint supplies, per process, single-flight: every reader of a mint inside the TTL shares one read,
 * and the reads of one call go out as one batch (getMultipleAccounts, 100 mints a call). A stale
 * reading is still answered while its re-read is out, and a failed read keeps it, so a slow or
 * failing RPC costs freshness, never the figure.
 */
export class MintSupplies implements MintSupplySource {
  private readonly entries = new Map<string, { supply: number; at: number }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly reader: MintSupplyReader,
    opts: MintSupplyOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.waitMs = opts.waitMs ?? 1_500;
    this.maxEntries = opts.maxEntries ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  async get(mints: readonly string[], waitMs?: number): Promise<Map<string, number>> {
    const wait = waitMs ?? this.waitMs;
    const unique = [...new Set(mints)];
    const now = this.now();
    const due = unique.filter((m) => {
      const hit = this.entries.get(m);
      return !hit || now - hit.at >= this.ttlMs;
    });
    const toRead = due.filter((m) => !this.inFlight.has(m));
    if (toRead.length > 0) {
      const read = this.reader
        .getMintSupplies(toRead)
        .then((found) => {
          const at = this.now();
          for (const [mint, supply] of found) {
            if (!(Number.isFinite(supply) && supply > 0)) continue;
            this.entries.delete(mint);
            this.entries.set(mint, { supply, at });
          }
          while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
          }
        })
        .catch((err: unknown) => {
          logger.warn("mint supply read failed", { mints: toRead.length, error: String(err) });
        })
        .finally(() => {
          for (const m of toRead) if (this.inFlight.get(m) === read) this.inFlight.delete(m);
        });
      for (const m of toRead) this.inFlight.set(m, read);
    }
    // Only a mint with no reading at all is waited on; a stale one answers now and refreshes behind.
    const waits = [
      ...new Set(due.filter((m) => !this.entries.has(m)).flatMap((m) => this.inFlight.get(m) ?? [])),
    ];
    if (waits.length > 0 && wait > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const out = new Map<string, number>();
    for (const m of unique) {
      const hit = this.entries.get(m);
      if (hit) out.set(m, hit.supply);
    }
    return out;
  }
}

let shared: MintSupplySource | null = null;

/** Sets the process's mint supplies (API and worker startup); null leaves every figure as read. */
export function configureMintSupplies(source: MintSupplySource | null): void {
  shared = source;
}

/** The process's mint supplies; without one configured, nothing is known and nothing is rescaled. */
export function mintSupplies(): MintSupplySource {
  return shared ?? { get: async () => new Map() };
}

/**
 * A market cap read on Pump.fun's launch billion, put on the coin's supply now. Unchanged when the
 * supply is unknown (the launch billion is then the best figure there is).
 */
export function onCurrentSupply(mcapOnLaunchSupply: number, supply: number | undefined): number {
  return supply !== undefined && supply > 0
    ? (mcapOnLaunchSupply * supply) / PUMP_SUPPLY_TOKENS
    : mcapOnLaunchSupply;
}

/**
 * Per mint, what a launch-billion market cap is multiplied by to read on the supply now
 * (supply / 1B); a mint with no reading is missing (a factor of 1).
 */
export async function launchSupplyFactors(
  mints: readonly string[],
  source: MintSupplySource = mintSupplies(),
): Promise<Map<string, number>> {
  const supplies = await source.get(mints).catch(() => new Map<string, number>());
  return new Map([...supplies].map(([mint, supply]) => [mint, supply / PUMP_SUPPLY_TOKENS]));
}

/**
 * Readings whose market cap is re-made as their price on the supply now, where both are known;
 * the rest are returned as they came. `only` picks the readings to re-make (default: all);
 * `waitMs` bounds the wait on a mint not read yet.
 */
export async function onCurrentSupplies<
  T extends { mintAddress: string; priceUsd: number; marketCapUsd: number },
>(
  tokens: T[],
  opts: { only?: (t: T) => boolean; waitMs?: number; source?: MintSupplySource } = {},
): Promise<T[]> {
  const only = opts.only ?? (() => true);
  const ask = tokens.filter((t) => t.priceUsd > 0 && only(t)).map((t) => t.mintAddress);
  if (ask.length === 0) return tokens;
  const source = opts.source ?? mintSupplies();
  const supplies = await source.get(ask, opts.waitMs).catch(() => new Map<string, number>());
  if (supplies.size === 0) return tokens;
  return tokens.map((t) => {
    const supply = supplies.get(t.mintAddress);
    return supply !== undefined && t.priceUsd > 0 && only(t)
      ? { ...t, marketCapUsd: t.priceUsd * supply }
      : t;
  });
}
