import { CreditTally } from "@trenchscanner/core";

/**
 * The Helius credits of the scan's stages that have no counter of their own, as billed (answered
 * calls only), for the scan heartbeat beside linkedWalletCalls, holderTransferCalls, liveTape and
 * sniperReads (Helius audit 2026-10-22, H-8). The stages run side by side, so the cycle's
 * per-method rpcCalls can't split them.
 */
export const heliusStageCredits = {
  /** Wallet freshness and the launch buyers' (walletFreshness.ts): signatures pages, sorted lookups. */
  freshness: new CreditTally(),
  /** The empty-wallet check's balances and mint decimals (walletValuation.ts). */
  balances: new CreditTally(),
  /** RugCheck's backup holder lists (onChainHolders.ts). */
  onChainHolders: new CreditTally(),
};

/** Each stage's credits since the last call. */
export function takeHeliusStageCredits(): Record<keyof typeof heliusStageCredits, number> {
  return {
    freshness: heliusStageCredits.freshness.take(),
    balances: heliusStageCredits.balances.take(),
    onChainHolders: heliusStageCredits.onChainHolders.take(),
  };
}
