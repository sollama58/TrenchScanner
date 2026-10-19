import { prisma, type Prisma } from "@trenchscanner/core";

/**
 * The statement timeout of the hourly reads over the whole of TokenWalletActivity (wallet-risk,
 * kol-side-wallets). The pool's own 150 s (core's db.ts) would fail them every hour once the table
 * nears its 30-day plateau of ~12 M rows (database audit 2026-10-19: kol-side-wallets took 52 s at
 * 2.0 M rows, growing ~400 k a day), freezing WalletRisk and the side lists at their last rebuild.
 */
export const WALLET_BOOK_READ_TIMEOUT_MS = 600_000;

/** Runs `read` in a transaction whose statements may take up to `timeoutMs` each. */
export function withLongReads<T>(
  read: (tx: Prisma.TransactionClient) => Promise<T>,
  timeoutMs = WALLET_BOOK_READ_TIMEOUT_MS,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // The bound rides the transaction's connection, these statements alone.
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return read(tx);
    },
    { maxWait: 10_000, timeout: timeoutMs + 30_000 },
  );
}
