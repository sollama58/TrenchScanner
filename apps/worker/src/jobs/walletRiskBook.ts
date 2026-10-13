import { prisma, createLogger, type ScoredWallet } from "@trenchscanner/core";

const logger = createLogger("wallet-risk-book");

/**
 * The scanner's copy of the wallet risk scores (WalletRisk), for the per-coin readings recorded at
 * each decision (coinWalletRisk in core's wallets/riskScore.ts). The table is rebuilt hourly by the
 * trainer, so this re-reads it every RELOAD_MS, in the background: a cycle never waits on it, and
 * reads nothing at all until the first load lands.
 */
const RELOAD_MS = 10 * 60_000;

let book: Map<string, ScoredWallet> = new Map();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Starts a reload when the copy is due; never throws, never waits. */
export function refreshWalletRiskBook(now = Date.now()): void {
  if (loading || now - loadedAt < RELOAD_MS) return;
  loading = prisma.walletRisk
    .findMany({
      select: {
        wallet: true,
        score: true,
        dumps: true,
        winScore: true,
        earlyWins: true,
        dumper: true,
        winner: true,
      },
    })
    .then((rows) => {
      book = new Map(
        rows.map((r) => [
          r.wallet,
          {
            score: r.score,
            dumps: r.dumps,
            winScore: r.winScore,
            earlyWins: r.earlyWins,
            dumper: r.dumper,
            winner: r.winner,
          },
        ]),
      );
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

/** Test hook. */
export function setWalletRiskBook(entries: [string, ScoredWallet][]): void {
  book = new Map(entries);
  loadedAt = Date.now();
}
