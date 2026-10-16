import {
  prisma,
  createLogger,
  scorePercentile,
  type OwnTapeRow,
  type ScoredWallet,
  type WalletRiskAsOf,
} from "@trenchscanner/core";

const logger = createLogger("wallet-risk-book");

/**
 * The scanner's copy of the wallet risk scores (WalletRisk), for the per-coin readings recorded at
 * each decision (coinWalletRisk in core's wallets/riskScore.ts). The table is rebuilt hourly by the
 * trainer, so this re-reads it every RELOAD_MS, in the background: a cycle never waits on it, and
 * reads nothing at all until the first load lands.
 *
 * 2026-10-16 (data-correctness audit): the copy also carries the counts behind each score, the
 * market dump rate the table was built with and when (the "wallet-risk" heartbeat, written by
 * the rebuild), and every score sorted, so a decision can read a wallet without the coin's own
 * tape and place the max among the wallets scored at the time (walletRiskScale).
 */
const RELOAD_MS = 10 * 60_000;

let book: Map<string, ScoredWallet> = new Map();
let sortedScores: number[] = [];
let marketDumpRate: number | null = null;
let builtAt: Date | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Starts a reload when the copy is due; never throws, never waits. */
export function refreshWalletRiskBook(now = Date.now()): void {
  if (loading || now - loadedAt < RELOAD_MS) return;
  loading = Promise.all([
    prisma.walletRisk.findMany({
      select: {
        wallet: true,
        score: true,
        appearances: true,
        dumps: true,
        fastExits: true,
        snipes: true,
        winScore: true,
        earlyWins: true,
        dumper: true,
        winner: true,
        walletScore: true,
      },
    }),
    prisma.systemHeartbeat.findUnique({
      where: { job: "wallet-risk" },
      select: { lastSuccessAt: true, meta: true },
    }),
  ])
    .then(([rows, heartbeat]) => {
      book = new Map(
        rows.map((r) => [
          r.wallet,
          {
            score: r.score,
            appearances: r.appearances,
            dumps: r.dumps,
            fastExits: r.fastExits,
            snipes: r.snipes,
            winScore: r.winScore,
            earlyWins: r.earlyWins,
            dumper: r.dumper,
            winner: r.winner,
            walletScore: r.walletScore,
          },
        ]),
      );
      sortedScores = rows.map((r) => r.score).sort((a, b) => a - b);
      // The rebuild's own rate (walletRiskJob.ts meta), rounded to four places there: a score
      // rebuilt against it is within rounding of the table's.
      const rate = (heartbeat?.meta as { marketDumpRate?: unknown } | null)?.marketDumpRate;
      marketDumpRate = typeof rate === "number" && Number.isFinite(rate) ? rate : null;
      builtAt = heartbeat?.lastSuccessAt ?? new Date();
      loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      // Tried again after the interval, not every cycle.
      loadedAt = Date.now();
      logger.warn("wallet risk load failed", { error: String(err) });
    })
    .finally(() => (loading = null));
}

/** The lookup, or undefined while no score is loaded (unknown, not "no risky wallets"). */
export function walletRiskLookup(): ((wallet: string) => ScoredWallet | undefined) | undefined {
  if (book.size === 0) return undefined;
  const current = book;
  return (wallet) => current.get(wallet);
}

/**
 * The scale the loaded copy was built on: the market dump rate (null before a rebuild has written
 * its heartbeat), the rank of a score among every wallet scored, and when the table was built.
 * Undefined while no score is loaded.
 */
export function walletRiskScale():
  (Pick<WalletRiskAsOf, "marketDumpRate"> & { rank: (score: number) => number; builtAt: Date }) | undefined {
  if (book.size === 0 || !builtAt) return undefined;
  const scores = sortedScores;
  return { marketDumpRate, rank: (score) => scorePercentile(scores, score), builtAt };
}

/**
 * Each coin's rows on its own trade tape, for the wallets a decision reads (2026-10-16,
 * data-correctness audit, skew section 9): what the hourly rebuild counted for this coin, which a
 * repeat decision on it must not read back. Only coins with a token row and a finished tape have
 * any; rows read after the table was built aren't in the scores yet and are left out. Keyed by
 * mint; a coin without rows is absent (nothing to take out). Null when the read failed: the
 * wallet risk readings are then left off the cycle rather than read with the coins' own results.
 */
export async function ownTapesOf(
  coins: readonly { mintAddress: string; tokenId?: string; wallets: readonly string[] }[],
  builtAt: Date,
): Promise<Map<string, ReadonlyMap<string, OwnTapeRow>> | null> {
  const out = new Map<string, Map<string, OwnTapeRow>>();
  const withToken = coins.filter((c) => c.tokenId && c.wallets.length > 0);
  if (withToken.length === 0) return out;
  try {
    const tapes = await prisma.tokenTradeTape.findMany({
      where: { tokenId: { in: withToken.map((c) => c.tokenId!) }, status: { in: ["done", "partial"] } },
      select: { tokenId: true },
    });
    if (tapes.length === 0) return out;
    const taped = new Set(tapes.map((t) => t.tokenId));
    const coinsOnTape = withToken.filter((c) => taped.has(c.tokenId!));
    const rows = await prisma.tokenWalletActivity.findMany({
      where: {
        tokenId: { in: coinsOnTape.map((c) => c.tokenId!) },
        wallet: { in: [...new Set(coinsOnTape.flatMap((c) => c.wallets))] },
        buys: { gt: 0 },
        createdAt: { lte: builtAt },
      },
      select: { tokenId: true, wallet: true, dumpedIntoStop: true, fastExit: true, launchSniper: true },
    });
    const mintOf = new Map(coinsOnTape.map((c) => [c.tokenId!, c.mintAddress]));
    for (const r of rows) {
      const mint = mintOf.get(r.tokenId)!;
      const own = out.get(mint) ?? new Map<string, OwnTapeRow>();
      own.set(r.wallet, {
        dumpedIntoStop: r.dumpedIntoStop,
        fastExit: r.fastExit,
        launchSniper: r.launchSniper,
      });
      out.set(mint, own);
    }
    return out;
  } catch (err) {
    logger.warn("own tape read failed - wallet risk readings left off this cycle", { error: String(err) });
    return null;
  }
}

/** Test hook. */
export function setWalletRiskBook(
  entries: [string, ScoredWallet][],
  scale?: { marketDumpRate?: number | null },
): void {
  book = new Map(entries);
  sortedScores = entries.map(([, w]) => w.score).sort((a, b) => a - b);
  marketDumpRate = scale?.marketDumpRate ?? null;
  builtAt = new Date();
  loadedAt = Date.now();
}
