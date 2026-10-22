import type { ChainTx } from "../wallets/tradeTape.js";

/**
 * The pages a launch-buyer read already paid for (getTransactionsForAddress, oldest first, the
 * same call the trade tape makes). The tape starts after them instead of buying those pages
 * again. Chain data does not change, so the trades are parsed when the tape takes the seed,
 * at the prices it would have used then. The read runs while the coin is young, so a short page
 * is only the end of the history so far, not of the coin's window; the tape decides from the
 * seed's newest block time whether the seed covers the window. It drops a seed older than the
 * tape's own look at it.
 *
 * Process memory, capped. A restart re-reads the pages. One mint keeps the latest read.
 */

export interface LaunchTapeSeed {
  txs: ChainTx[];
  /** Pages this covers. The tape counts them toward the per-coin page cap. */
  pages: number;
  /** Newest trade time of each page, milliseconds. 0 when a page had no block time. */
  pageEnds: number[];
  /**
   * Pass to the next getMintTransactionsPage. Kept after a short page too, since the history
   * goes on after the read. Null when the read got no token: the seed then reads as whole only
   * when its pages already reach past the coin's window.
   */
  paginationToken: string | null;
  at: number;
}

/** Three pages is the launch read's own cap. A longer list is not one of these seeds. */
const MAX_TXS = 300;
/** Mints remembered at once. The least recently written goes first. */
const MAX_SEEDS = 150;

const seeds = new Map<string, LaunchTapeSeed>();

export function rememberLaunchTapeSeed(
  mint: string,
  seed: Omit<LaunchTapeSeed, "at">,
  now = Date.now(),
): void {
  if (seed.txs.length === 0 || seed.txs.length > MAX_TXS || seed.pages <= 0) return;
  seeds.delete(mint);
  seeds.set(mint, { ...seed, txs: seed.txs.slice(), pageEnds: seed.pageEnds.slice(), at: now });
  while (seeds.size > MAX_SEEDS) {
    const oldest = seeds.keys().next().value;
    if (oldest === undefined) break;
    seeds.delete(oldest);
  }
}

/** The seed for `mint`, removed. Undefined when there is none or it is older than `maxAgeMs`. */
export function takeLaunchTapeSeed(
  mint: string,
  maxAgeMs: number,
  now = Date.now(),
): LaunchTapeSeed | undefined {
  const seed = seeds.get(mint);
  if (!seed) return undefined;
  seeds.delete(mint);
  if (now - seed.at > maxAgeMs) return undefined;
  return seed;
}

export function resetLaunchTapeSeeds(): void {
  seeds.clear();
}
