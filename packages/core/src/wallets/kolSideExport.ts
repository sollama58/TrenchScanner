/**
 * Extra wallets for the Side Wallet Checker's KOL export (user ask 2026-10-22): bwam_dev's listed
 * side wallets that are not already in the labeled export.
 */

export interface ListedSideWallet {
  wallet: string;
  pct: number;
}

/**
 * Wallets from bwam_dev's 30d list, numbered bwam_dev_N from `firstNumber`, minus bots and wallets
 * already exported. The numbers continue after bwam_dev's labeled sides, so no two lines of the
 * toggle's export share a name.
 */
export function bwamDevSideExportWallets(
  listed: readonly ListedSideWallet[],
  likelyBots: ReadonlySet<string>,
  alreadyExported: ReadonlySet<string>,
  kolName = "bwam_dev",
  firstNumber = 1,
): { wallet: string; name: string }[] {
  const stem = kolName.replace(/[\s,]+/g, "_");
  return listed
    .filter((s) => !likelyBots.has(s.wallet) && !alreadyExported.has(s.wallet))
    .sort((a, b) => b.pct - a.pct || (a.wallet < b.wallet ? -1 : 1))
    .map((s, i) => ({ wallet: s.wallet, name: `${stem}_${i + firstNumber}` }));
}
