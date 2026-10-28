import type { WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { PRIVY_WALLET_NAME } from "./privyBridge";
import { legacyWallets, solanaWallets, withTimeout } from "./wallet";

/**
 * Signing Trade Buddy's link message with one of the reader's other wallets (user decision
 * 2026-10-27, Card 11): whichever wallet and account the reader picks in this browser, not the one
 * they signed in with. The message names the wallet, so it is asked for once the wallet has said
 * which account it shares.
 */
export interface LinkSigner {
  key: string;
  name: string;
  icon?: string;
  /** Connects, asks `messageFor` the account's message, and signs it: the address and signature (base58). */
  sign(messageFor: (address: string) => Promise<string>): Promise<{ address: string; signature: string }>;
}

export function linkSigners(): LinkSigner[] {
  const standard = solanaWallets().filter(
    (w) => w.name !== PRIVY_WALLET_NAME && SolanaSignMessage in w.features,
  );
  const signers: LinkSigner[] = standard.map((wallet, i) => ({
    key: `std:${wallet.name}:${i}`,
    name: wallet.name,
    icon: wallet.icon,
    sign: async (messageFor) => {
      const connect = (wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
      if (!connect) throw new Error(`${wallet.name} can't connect`);
      const { accounts } = await withTimeout(connect.connect(), "connect");
      const account: WalletAccount | undefined = accounts[0];
      if (!account)
        throw new Error(`${wallet.name} shared no account. Unlock it, pick an account, and try again.`);
      const message = await messageFor(account.address);
      const signMessage = (wallet.features as SolanaSignMessageFeature)[SolanaSignMessage];
      const [signed] = await withTimeout(
        signMessage.signMessage({ account, message: new TextEncoder().encode(message) }),
        "sign",
      );
      if (!signed) throw new Error("The wallet returned no signature");
      return { address: account.address, signature: bs58.encode(signed.signature) };
    },
  }));
  const names = standard.map((w) => w.name.toLowerCase());
  for (const legacy of legacyWallets()) {
    if (names.some((n) => n.includes(legacy.name.toLowerCase()))) continue;
    names.push(legacy.name.toLowerCase());
    signers.push({
      key: `legacy:${legacy.name}`,
      name: legacy.name,
      sign: async (messageFor) => {
        const connected = await withTimeout(legacy.provider.connect(), "connect");
        const address = (connected?.publicKey ?? legacy.provider.publicKey)?.toString();
        if (!address)
          throw new Error(`${legacy.name} shared no account. Unlock it, pick an account, and try again.`);
        const message = await messageFor(address);
        const signed = await withTimeout(
          legacy.provider.signMessage(new TextEncoder().encode(message), "utf8"),
          "sign",
        );
        const signature = signed instanceof Uint8Array ? signed : signed?.signature;
        if (!signature) throw new Error("The wallet returned no signature");
        return { address, signature: bs58.encode(Uint8Array.from(signature)) };
      },
    });
  }
  return signers;
}
