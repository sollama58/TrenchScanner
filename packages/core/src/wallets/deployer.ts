import { isWalletAddress } from "../solana.js";
import { keysOf, type ChainTx } from "./tradeTape.js";

/**
 * The wallet that deployed a coin, read off its first transaction (user bug report 2026-10-24:
 * Asyl named a community takeover's wallet as a Pump.fun coin's deployer). Pump.fun's `creator`
 * follows the creator fee, which a takeover moves to a new wallet; the coin's create transaction
 * never changes, and the wallet that signed it is the deployer.
 *
 * `txs` are the mint's transactions oldest first (Helius getTransactionsForAddress, full details).
 * The deployer is the first signer of the first one that succeeded that is a wallet, on the
 * ed25519 curve, and not the mint's own keypair: never a token account or a program address.
 */
export function deployerFromTransactions(
  mint: string,
  txs: readonly ChainTx[],
  walletCheck: (address: string) => boolean = isWalletAddress,
): { deployer: string; at: Date | null; signature: string | null } | null {
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const keys = keysOf(tx);
    const signers = tx.transaction?.message?.header?.numRequiredSignatures ?? 1;
    const deployer = keys.slice(0, Math.max(1, signers)).find((k) => k && k !== mint && walletCheck(k));
    if (!deployer) return null;
    return {
      deployer,
      at: typeof tx.blockTime === "number" ? new Date(tx.blockTime * 1000) : null,
      signature: tx.transaction?.signatures?.[0] ?? null,
    };
  }
  return null;
}
