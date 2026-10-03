import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import {
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  type SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { api, post, type User } from "./api";

/**
 * Wallet sign-in over the Wallet Standard - the registry Phantom, Solflare, Backpack and the rest
 * announce themselves on - so no per-wallet adapter code ships in this bundle.
 *
 * Prefers solana:signIn, the domain-bound flow: the wallet checks the message's domain against
 * this page before signing. Falls back to a plain signMessage for wallets without it, which the
 * API also accepts.
 */

export function solanaWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c.startsWith("solana:")) && StandardConnect in w.features);
}

/** Calls back whenever a wallet registers or unregisters (extensions load after the page). */
export function onWalletsChanged(callback: () => void): () => void {
  const { on } = getWallets();
  const offRegister = on("register", callback);
  const offUnregister = on("unregister", callback);
  return () => {
    offRegister();
    offUnregister();
  };
}

interface NonceResponse {
  nonce: string;
  message: string;
  signInInput: SolanaSignInInput;
}

export async function signInWithWallet(wallet: Wallet): Promise<User> {
  const connect = (wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
  if (!connect) throw new Error(`${wallet.name} can't connect`);
  const { accounts } = await connect.connect();
  const account: WalletAccount | undefined = accounts[0];
  if (!account) throw new Error(`${wallet.name} shared no account`);

  const issued = await api<NonceResponse>(`/auth/nonce?wallet=${encodeURIComponent(account.address)}`);

  const signIn = (wallet.features as Partial<SolanaSignInFeature>)[SolanaSignIn];
  if (signIn) {
    const [output] = await signIn.signIn(issued.signInInput);
    if (!output) throw new Error("The wallet returned no signature");
    return post<User>("/auth/verify", {
      method: "signIn",
      walletAddress: account.address,
      nonce: issued.nonce,
      output: {
        publicKey: bs58.encode(Uint8Array.from(output.account.publicKey)),
        signedMessage: bs58.encode(output.signedMessage),
        signature: bs58.encode(output.signature),
      },
    });
  }

  const signMessage = (wallet.features as Partial<SolanaSignMessageFeature>)[SolanaSignMessage];
  if (!signMessage) throw new Error(`${wallet.name} can't sign messages`);
  const [signed] = await signMessage.signMessage({
    account,
    message: new TextEncoder().encode(issued.message),
  });
  if (!signed) throw new Error("The wallet returned no signature");
  return post<User>("/auth/verify", {
    method: "signMessage",
    walletAddress: account.address,
    nonce: issued.nonce,
    signature: bs58.encode(signed.signature),
  });
}
