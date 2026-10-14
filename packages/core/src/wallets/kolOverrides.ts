/**
 * KOL wallets named by hand, for wallets Solana Tracker's roster leaves out or names wrongly. The
 * worker writes these into KolWallet on boot and after every roster read (kolWalletsJob.ts), so
 * every place that shows a KOL name reads them like any roster KOL: holder lists, the wallet
 * modal, the Side Wallet Checker, possible-side labels, bubble maps and their share images. An
 * entry here wins over the roster's name and is never dropped as stale.
 */
export interface KolOverride {
  name: string;
  /** X handle without the "@", when known. */
  twitter?: string | null;
}

export const KOL_OVERRIDES: ReadonlyMap<string, KolOverride> = new Map([
  // User ask 2026-10-14: the roster's entry for this wallet showed broken.
  ["5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM", { name: "Schoen" }],
]);
