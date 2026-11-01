import type { TapeTrade } from "./tradeTape.js";

/**
 * Recurring wallet cohorts (data-uses evaluation 2026-11-01, notes/data-uses-2026-11-01/report.md
 * §3 and brief 3): wallets that keep buying the same launches together in the first two minutes,
 * within two seconds of each other - one owner's row of wallets, or a group trading one script.
 *
 * Built hourly by the trainer (worker's walletCohortJob.ts) from the trade tape already stored
 * (TokenWalletActivity): no outside call.
 *
 * - A seed is a wallet first-buying in COHORT_MIN_COINS+ taped coins inside the launch's first
 *   COHORT_EARLY_SEC, and in under COHORT_MAX_COIN_SHARE of all such coins (never under
 *   COHORT_BOT_MIN_COINS, so a small tape doesn't bar everyone): a wallet in more than 1% of every
 *   launch read is a service bot or a pro sniper, never one owner of a coin.
 * - A pair is two seeds whose first buys of the same coin are within COHORT_PAIR_GAP_SEC.
 * - A pair is kept when it shares COHORT_MIN_PAIR_COINS+ coins and those are at least
 *   COHORT_MIN_JACCARD of everything either did (together / (a + b - together)): two wallets that
 *   met twice among hundreds of coins each are a coincidence, two that met twice among six are not.
 * - A cohort is a connected component of the kept pairs.
 *
 * On 17,139 production tapes, read point-in-time, 41% of coins with 20+ early buyers carried a
 * cohort among them and those coins reached 2x 13.6% of the time against 17.2% without; a cohort
 * tied to the creator (the creator of one of its coins is a member) held more of the supply and
 * was the stronger stop-side signal. The cohort inputs (curation/features.ts COHORT_FEATURES) are
 * recorded only until a week of live rows holds what the export measured.
 */
export const COHORT_MIN_COINS = 3;
export const COHORT_MAX_COIN_SHARE = 0.01;
export const COHORT_BOT_MIN_COINS = 50;
export const COHORT_EARLY_SEC = 120;
export const COHORT_PAIR_GAP_SEC = 2;
export const COHORT_MIN_PAIR_COINS = 2;
export const COHORT_MIN_JACCARD = 0.25;

/** A pair of seeds and the coins they first-bought together, as the hourly rebuild reads it. */
export interface CohortPairInput {
  a: string;
  b: string;
  /** The coins both first-bought within COHORT_PAIR_GAP_SEC, in the launch's first COHORT_EARLY_SEC. */
  tokens: readonly string[];
  /** The latest of those first buys. */
  lastAt: Date;
}

/** One wallet's row in the cohort book (WalletCohort). */
export interface CohortRow {
  wallet: string;
  /** The cohort: its smallest wallet address, so the id is the same from one rebuild to the next. */
  cohortId: string;
  /** Wallets in the cohort. */
  size: number;
  /** Coins this wallet first-bought with a cohort-mate. */
  coins: number;
  /** Of the cohort's coins, those whose creator is in the cohort: a dev's own row of wallets. */
  creatorCoins: number;
  lastSeenAt: Date;
}

export interface CohortPairRow {
  a: string;
  b: string;
  coins: number;
  lastAt: Date;
}

/** The Jaccard overlap of two seeds' coins given how many each first-bought early. */
export function pairJaccard(together: number, coinsA: number, coinsB: number): number {
  const union = coinsA + coinsB - together;
  return union > 0 ? together / union : 0;
}

/**
 * The cohort book from this hour's pairs: the kept pairs (COHORT_MIN_PAIR_COINS, COHORT_MIN_JACCARD),
 * their connected components, and each member's row. `coinsOf` is each seed's own early coin count
 * and `creatorOf` each coin's creator wallet (absent when unknown).
 */
export function buildCohorts(
  pairs: readonly CohortPairInput[],
  coinsOf: ReadonlyMap<string, number>,
  creatorOf: ReadonlyMap<string, string>,
): { rows: CohortRow[]; pairs: CohortPairRow[] } {
  const kept = pairs.filter((p) => {
    const together = new Set(p.tokens).size;
    if (together < COHORT_MIN_PAIR_COINS) return false;
    const ca = coinsOf.get(p.a) ?? together;
    const cb = coinsOf.get(p.b) ?? together;
    return pairJaccard(together, ca, cb) >= COHORT_MIN_JACCARD;
  });
  // Union-find over the kept pairs' wallets.
  const parent = new Map<string, string>();
  const find = (w: string): string => {
    let root = w;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    let cur = w;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const p of kept) union(p.a, p.b);

  // Each wallet's coins and last buy over its kept pairs, and each cohort's coins.
  const walletCoins = new Map<string, Set<string>>();
  const walletLast = new Map<string, number>();
  const cohortCoins = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, values: readonly string[]) => {
    const set = map.get(key) ?? new Set<string>();
    for (const v of values) set.add(v);
    map.set(key, set);
  };
  for (const p of kept) {
    const root = find(p.a);
    add(walletCoins, p.a, p.tokens);
    add(walletCoins, p.b, p.tokens);
    add(cohortCoins, root, p.tokens);
    const at = p.lastAt.getTime();
    walletLast.set(p.a, Math.max(walletLast.get(p.a) ?? 0, at));
    walletLast.set(p.b, Math.max(walletLast.get(p.b) ?? 0, at));
  }
  // The cohort's id is its smallest member, and its members and creator-tied coins are counted once.
  const members = new Map<string, string[]>();
  for (const w of walletCoins.keys()) {
    const root = find(w);
    const list = members.get(root) ?? [];
    list.push(w);
    members.set(root, list);
  }
  const rows: CohortRow[] = [];
  for (const [root, wallets] of members) {
    wallets.sort();
    const cohortId = wallets[0]!;
    const memberSet = new Set(wallets);
    const coins = cohortCoins.get(root) ?? new Set<string>();
    let creatorCoins = 0;
    for (const t of coins) {
      const creator = creatorOf.get(t);
      if (creator !== undefined && memberSet.has(creator)) creatorCoins += 1;
    }
    for (const w of wallets) {
      rows.push({
        wallet: w,
        cohortId,
        size: wallets.length,
        coins: walletCoins.get(w)!.size,
        creatorCoins,
        lastSeenAt: new Date(walletLast.get(w)!),
      });
    }
  }
  rows.sort((x, y) => (x.wallet < y.wallet ? -1 : x.wallet > y.wallet ? 1 : 0));
  const pairRows: CohortPairRow[] = kept.map((p) => ({
    a: p.a < p.b ? p.a : p.b,
    b: p.a < p.b ? p.b : p.a,
    coins: new Set(p.tokens).size,
    lastAt: p.lastAt,
  }));
  return { rows, pairs: pairRows };
}

/** What a decision records from the cohort book about the wallets buying in the coin's newest trades. */
export interface CohortReading {
  /** % of the page's buyers (each once) that are in a cohort; null with no buyers. */
  cohortRecentBuyersPct: number | null;
  /** The largest cohort among them (wallets); 0 when none is in one. */
  cohortRecentMaxSize: number;
  /**
   * 1 when a buyer's cohort has a creator among its members - this coin's creator, or the creator
   * of one of the cohort's earlier coins - else 0. Null with no buyers.
   */
  cohortCreatorLinked: number | null;
}

/**
 * The cohort reading off a live page: each buying wallet once, looked up in the cohort book.
 * `creator` is this coin's creator when known; a buyer sharing a cohort with it is creator-linked
 * whatever the cohort's earlier coins say.
 */
export function cohortReading(
  trades: readonly TapeTrade[],
  lookup: (wallet: string) => Pick<CohortRow, "cohortId" | "size" | "creatorCoins"> | undefined,
  creator?: string | null,
): CohortReading {
  const seen = new Set<string>();
  let inCohort = 0;
  let maxSize = 0;
  let creatorLinked = false;
  const creatorCohort = creator ? lookup(creator)?.cohortId : undefined;
  for (const t of trades) {
    if (t.side !== "buy" || seen.has(t.wallet)) continue;
    seen.add(t.wallet);
    const row = lookup(t.wallet);
    if (!row) continue;
    inCohort += 1;
    if (row.size > maxSize) maxSize = row.size;
    if (row.creatorCoins > 0 || (creatorCohort !== undefined && row.cohortId === creatorCohort))
      creatorLinked = true;
  }
  if (seen.size === 0)
    return { cohortRecentBuyersPct: null, cohortRecentMaxSize: 0, cohortCreatorLinked: null };
  return {
    cohortRecentBuyersPct: Math.round((inCohort / seen.size) * 1000) / 10,
    cohortRecentMaxSize: maxSize,
    cohortCreatorLinked: creatorLinked ? 1 : 0,
  };
}
