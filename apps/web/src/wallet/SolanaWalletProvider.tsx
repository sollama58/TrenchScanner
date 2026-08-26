import type { ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import "@solana/wallet-adapter-react-ui/styles.css";

const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || "https://solana-rpc.publicnode.com";

/**
 * Sign-in never submits a transaction (SIWS just signs a message), so this
 * connection is only used by the wallet adapter's internal plumbing - any
 * reachable RPC endpoint works, no paid/high-throughput provider needed.
 *
 * No explicit wallet adapters (no @solana/wallet-adapter-wallets, deliberately)
 * - Phantom, Solflare, Backpack, and every other current wallet implement the
 * Wallet Standard, which @solana/wallet-adapter-react auto-detects via the
 * browser's wallet registry. Explicit adapters are now only needed for
 * legacy wallets that predate the standard, which isn't a case we need to
 * cover. This keeps the dependency tree (and its vulnerability surface)
 * drastically smaller.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
