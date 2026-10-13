import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("kol-wallet-book");

/**
 * The scanner's copy of the KOL roster (KolWallet, refreshed daily by kolWalletsJob.ts), for the
 * KOL counts recorded at each decision (user ask 2026-10-13): KOLs among the top holders, the
 * first buyers, and the newest trades. Re-read every RELOAD_MS in the background, like the wallet
 * risk book: a cycle never waits on it, and the counts are unknown (not zero) until the first
 * load lands or while the roster is empty (no SOLANA_TRACKER_API_KEY).
 */
const RELOAD_MS = 10 * 60_000;

let roster: Set<string> = new Set();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Starts a reload when the copy is due; never throws, never waits. */
export function refreshKolWalletBook(now = Date.now()): void {
  if (loading || now - loadedAt < RELOAD_MS) return;
  loading = prisma.kolWallet
    .findMany({ select: { wallet: true } })
    .then((rows) => {
      roster = new Set(rows.map((r) => r.wallet));
      loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      loadedAt = Date.now();
      logger.warn("KOL roster load failed", { error: String(err) });
    })
    .finally(() => (loading = null));
}

/** The lookup, or undefined while no roster is loaded (unknown, not "no KOLs"). */
export function kolLookup(): ((wallet: string) => boolean) | undefined {
  if (roster.size === 0) return undefined;
  const current = roster;
  return (wallet) => current.has(wallet);
}

/** Test hook. */
export function setKolWalletBook(wallets: readonly string[]): void {
  roster = new Set(wallets);
  loadedAt = Date.now();
}
