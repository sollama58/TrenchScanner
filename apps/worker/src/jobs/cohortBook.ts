import { prisma, createLogger, type CohortRow } from "@trenchscanner/core";

const logger = createLogger("cohort-book");

/**
 * The scanner's copy of the recurring wallet cohorts (WalletCohort, rebuilt hourly by the trainer's
 * walletCohortJob.ts), for the recorded-only cohort inputs (core's cohortReading). Re-read every
 * RELOAD_MS in the background, as walletRiskBook.ts does; a cycle never waits on it, and reads
 * nothing until the first load lands (unknown, not "no cohorts").
 */
const RELOAD_MS = 10 * 60_000;

type CohortEntry = Pick<CohortRow, "cohortId" | "size" | "creatorCoins">;
let book: Map<string, CohortEntry> = new Map();
let loaded = false;
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Starts a reload when the copy is due; never throws, never waits. */
export function refreshCohortBook(now = Date.now()): void {
  if (loading || now - loadedAt < RELOAD_MS) return;
  loading = prisma.walletCohort
    .findMany({ select: { wallet: true, cohortId: true, size: true, creatorCoins: true } })
    .then((rows) => {
      book = new Map(
        rows.map((r) => [r.wallet, { cohortId: r.cohortId, size: r.size, creatorCoins: r.creatorCoins }]),
      );
      loaded = true;
      loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      loadedAt = Date.now();
      logger.warn("cohort book load failed", { error: String(err) });
    })
    .finally(() => (loading = null));
}

/** The lookup, or undefined before the first load (unknown). An empty book after a load is known. */
export function cohortLookup(): ((wallet: string) => CohortEntry | undefined) | undefined {
  if (!loaded) return undefined;
  const current = book;
  return (wallet) => current.get(wallet);
}

/** Test hook. */
export function resetCohortBook(): void {
  book = new Map();
  loaded = false;
  loadedAt = 0;
  loading = null;
}
