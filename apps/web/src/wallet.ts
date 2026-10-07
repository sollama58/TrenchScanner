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
import { api, ApiError, post, type User } from "./api";
import { adoptSession } from "./sessionCheck";

/**
 * Wallet sign-in over the Wallet Standard - the registry Phantom, Solflare, Backpack and the rest
 * announce themselves on - so no per-wallet adapter code ships in this bundle.
 *
 * Prefers solana:signIn, the domain-bound flow: the wallet checks the message's domain against
 * this page before signing. Falls back to a plain signMessage for wallets without it, which the
 * API also accepts. Wallets that only inject the older window.solana-style provider are offered
 * too (legacyWallets), signing with signMessage.
 */

/** One way to sign in, as the sign-in screen lists it. */
export interface WalletOption {
  key: string;
  name: string;
  icon?: string;
  signIn: () => Promise<User>;
}

export function solanaWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c.startsWith("solana:")) && StandardConnect in w.features);
}

/** Every wallet this browser offers: Wallet Standard ones first, then legacy-only providers. */
export function walletOptions(): WalletOption[] {
  const standard = solanaWallets();
  const options: WalletOption[] = standard.map((w, i) => ({
    key: `std:${w.name}:${i}`,
    name: w.name,
    icon: w.icon,
    signIn: () => signInWithWallet(w).then((u) => remembered(u, w.name)),
  }));
  const names = standard.map((w) => w.name.toLowerCase());
  for (const legacy of legacyWallets()) {
    // The same extension usually announces itself both ways; the standard entry wins.
    if (names.some((n) => n.includes(legacy.name.toLowerCase()))) continue;
    names.push(legacy.name.toLowerCase());
    options.push({
      key: `legacy:${legacy.name}`,
      name: legacy.name,
      signIn: () => signInWithLegacy(legacy.name, legacy.provider).then((u) => remembered(u, legacy.name)),
    });
  }
  return options;
}

// ---- Which wallet this session signed in with ----

const SIGNED_IN_WALLET_KEY = "ts-signed-in-wallet";

function remembered(user: User, walletName: string): User {
  try {
    localStorage.setItem(
      SIGNED_IN_WALLET_KEY,
      JSON.stringify({ address: user.walletAddress, name: walletName }),
    );
  } catch {
    // Blocked storage: the burn button falls back to wallets already connected to this address.
  }
  return user;
}

/**
 * The name of the wallet extension `address` signed in with on this device, if known. The burn
 * button offers only that wallet: with several installed, any other one would be signing for a
 * different account (or the same account in a second app, which only confuses).
 */
export function signedInWalletName(address: string): string | null {
  try {
    const raw = localStorage.getItem(SIGNED_IN_WALLET_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { address?: unknown; name?: unknown };
    return saved.address === address && typeof saved.name === "string" ? saved.name : null;
  } catch {
    return null;
  }
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

type VerifyResponse = User & { sessionToken?: string };

/**
 * How long to wait on the wallet before saying so. Long enough to read and approve a prompt, short
 * enough that a popup hidden behind the window (or a locked extension that never opened one)
 * doesn't leave the button stuck on "Waiting for wallet" with no way out.
 */
const WALLET_TIMEOUT_MS = 90_000;

export class WalletTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WalletTimeoutError(what)), WALLET_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function signInWithWallet(wallet: Wallet): Promise<User> {
  const connect = (wallet.features as Partial<StandardConnectFeature>)[StandardConnect];
  if (!connect) throw new Error(`${wallet.name} can't connect`);
  const { accounts } = await withTimeout(connect.connect(), "connect");
  const account: WalletAccount | undefined = accounts[0];
  if (!account)
    throw new Error(`${wallet.name} shared no account. Unlock it, pick an account, and try again.`);

  const issued = await api<NonceResponse>(`/auth/nonce?wallet=${encodeURIComponent(account.address)}`);

  const signIn = (wallet.features as Partial<SolanaSignInFeature>)[SolanaSignIn];
  if (signIn) {
    const [output] = await withTimeout(signIn.signIn(issued.signInInput), "sign");
    if (!output) throw new Error("The wallet returned no signature");
    return finishSignIn(
      await post<VerifyResponse>("/auth/verify", {
        method: "signIn",
        walletAddress: account.address,
        nonce: issued.nonce,
        output: {
          publicKey: bs58.encode(Uint8Array.from(output.account.publicKey)),
          signedMessage: bs58.encode(output.signedMessage),
          signature: bs58.encode(output.signature),
        },
      }),
    );
  }

  const signMessage = (wallet.features as Partial<SolanaSignMessageFeature>)[SolanaSignMessage];
  if (!signMessage) throw new Error(`${wallet.name} can't sign messages`);
  const [signed] = await withTimeout(
    signMessage.signMessage({ account, message: new TextEncoder().encode(issued.message) }),
    "sign",
  );
  if (!signed) throw new Error("The wallet returned no signature");
  return finishSignIn(
    await post<VerifyResponse>("/auth/verify", {
      method: "signMessage",
      walletAddress: account.address,
      nonce: issued.nonce,
      signature: bs58.encode(signed.signature),
    }),
  );
}

/** Makes sure the session actually sticks before calling sign-in done (sessionCheck.ts). */
async function finishSignIn({ sessionToken, ...user }: VerifyResponse): Promise<User> {
  await adoptSession(sessionToken, "Your wallet signed");
  return user;
}

// ---- Legacy injected providers (window.solana and friends) ----

interface LegacyProvider {
  connect(): Promise<{ publicKey?: { toString(): string } } | undefined>;
  publicKey?: { toString(): string } | null;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

function isProvider(value: unknown): value is LegacyProvider {
  const p = value as Partial<LegacyProvider> | null | undefined;
  return !!p && typeof p.connect === "function" && typeof p.signMessage === "function";
}

/** Injected providers that predate the Wallet Standard, by the names their extensions use. */
export function legacyWallets(): { name: string; provider: LegacyProvider }[] {
  const w = window as unknown as Record<string, unknown> & {
    phantom?: { solana?: unknown };
    trustwallet?: { solana?: unknown };
    solana?: { isPhantom?: boolean };
  };
  const found: { name: string; provider: LegacyProvider }[] = [];
  const add = (name: string, provider: unknown) => {
    if (isProvider(provider) && !found.some((f) => f.provider === provider)) found.push({ name, provider });
  };
  add("Phantom", w.phantom?.solana);
  add("Solflare", w.solflare);
  add("Backpack", w.backpack);
  add("Coinbase Wallet", w.coinbaseSolana);
  add("Trust Wallet", w.trustwallet?.solana);
  add(w.solana?.isPhantom ? "Phantom" : "Solana wallet", w.solana);
  return found;
}

async function signInWithLegacy(name: string, provider: LegacyProvider): Promise<User> {
  const connected = await withTimeout(provider.connect(), "connect");
  const address = (connected?.publicKey ?? provider.publicKey)?.toString();
  if (!address) throw new Error(`${name} shared no account. Unlock it, pick an account, and try again.`);

  const issued = await api<NonceResponse>(`/auth/nonce?wallet=${encodeURIComponent(address)}`);
  const signed = await withTimeout(
    provider.signMessage(new TextEncoder().encode(issued.message), "utf8"),
    "sign",
  );
  const signature = signed instanceof Uint8Array ? signed : signed?.signature;
  if (!signature) throw new Error("The wallet returned no signature");
  return finishSignIn(
    await post<VerifyResponse>("/auth/verify", {
      method: "signMessage",
      walletAddress: address,
      nonce: issued.nonce,
      signature: bs58.encode(Uint8Array.from(signature)),
    }),
  );
}

// ---- What to tell the person when it fails ----

/** A plain-language reason for a failed sign-in, never an empty or bare technical one. */
export function describeSignInError(e: unknown, walletName: string): string {
  if (e instanceof WalletTimeoutError)
    return e.message === "connect"
      ? `${walletName} didn't answer. Its popup may be hidden behind this window, or the extension may be locked: open it from the toolbar, unlock it, then try again.`
      : `${walletName} didn't sign. Look for its popup (it may be behind this window), approve the message, then try again.`;
  if (e instanceof ApiError) {
    if (e.status === 401)
      return "The signature didn't verify. Try again, and make sure the wallet shows this site's address.";
    if (e.status === 429) return "Too many sign-in attempts. Wait a minute, then try again.";
    if (e.status >= 500) return "The TrenchScanner server had a problem. Try again in a moment.";
    return `Sign-in failed: ${e.message || `error ${e.status}`}.`;
  }
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (code === 4001 || /reject|denied|declin|cancel/i.test(message))
    return "You cancelled in the wallet. Press the wallet again when you're ready to sign.";
  if (e instanceof TypeError && /fetch|network|load failed/i.test(message))
    return "Couldn't reach the TrenchScanner server. Check your connection, and if an ad blocker or tracking prevention is set to Strict for this site, relax it, then try again.";
  if (/locked|unlock/i.test(message)) return `${walletName} is locked. Unlock it, then try again.`;
  if (message) return message;
  return `${walletName} stopped without saying why. Unlock it, reload this page, and try again.`;
}
