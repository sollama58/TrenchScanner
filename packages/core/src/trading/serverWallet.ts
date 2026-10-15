import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { prisma } from "../db.js";
import { looksLikeSolanaAddress } from "../solana.js";

/**
 * The server wallet: one wallet whose private key the operator supplies in the environment
 * (TRADING_SERVER_WALLET_SECRET_KEY, on the trader only), traded by a bot every admin controls.
 *
 * It is the same machinery as the per-user custodial wallets - its own bot, settings, positions
 * and withdrawals - owned by a reserved system account rather than a person, so everything the
 * engine does (the guard, the exit plan, settling, rebroadcast, recovery) applies unchanged. Only
 * where the key comes from differs: the environment instead of KMS.
 *
 * Where each piece lives, by design:
 *   - the secret key: the trader service only (the one process that signs). The api never sees
 *     it; it shows the wallet from TRADING_SERVER_WALLET_ADDRESS, which is public.
 *   - the withdrawal destination: TRADING_SERVER_WALLET_WITHDRAW_TO, in the environment too, so
 *     neither a database write nor a stolen admin session can redirect a withdrawal. Empty
 *     disables withdrawals (whoever holds the key can always move funds in their own wallet app).
 *
 * The trader refuses to sign with a key whose public key isn't TRADING_SERVER_WALLET_ADDRESS, so
 * a mistyped or swapped secret fails loudly instead of trading from an unexpected wallet.
 */

/**
 * The reserved account that owns the server wallet's bot and positions. Not a Solana address, so
 * Sign-In With Solana can never authenticate as it (no key signs for it).
 */
export const SERVER_WALLET_ACCOUNT = "server-wallet";

export interface ServerWalletKey {
  seed: Uint8Array;
  publicKey: string;
}

/**
 * Parses a private key as the wallets export it: base58 of the 64-byte secret key (Phantom,
 * Solflare - seed then public key) or of a 32-byte seed, or a JSON byte array of either length
 * (a solana-keygen file's contents). Throws without echoing the input.
 */
export function parseServerWalletKey(secret: string): ServerWalletKey {
  const text = secret.trim();
  let bytes: Uint8Array;
  try {
    if (text.startsWith("[")) {
      const arr = JSON.parse(text) as unknown;
      if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
        throw new Error();
      bytes = Uint8Array.from(arr as number[]);
    } else {
      bytes = bs58.decode(text);
    }
  } catch {
    throw new Error("the server wallet key is not base58 or a JSON byte array");
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(
      `the server wallet key is ${bytes.length} bytes; expected a 64-byte secret key or 32-byte seed`,
    );
  }
  const seed = bytes.slice(0, 32);
  const publicKey = bs58.encode(ed25519.getPublicKey(seed));
  if (bytes.length === 64 && bs58.encode(bytes.slice(32)) !== publicKey) {
    seed.fill(0);
    throw new Error("the server wallet key is inconsistent: its public half does not match its seed");
  }
  bytes.fill(0);
  return { seed, publicKey };
}

export interface ServerWalletEnv {
  TRADING_SERVER_WALLET_SECRET_KEY: string;
  TRADING_SERVER_WALLET_ADDRESS: string;
  TRADING_SERVER_WALLET_WITHDRAW_TO: string;
}

/** What the trader signs with: the key, checked against the declared address. */
export function loadServerWalletKey(
  env: ServerWalletEnv,
):
  | { key: ServerWalletKey & { withdrawTo: string | null }; problem?: undefined }
  | { key: null; problem: string | null } {
  if (!env.TRADING_SERVER_WALLET_SECRET_KEY) return { key: null, problem: null };
  if (!env.TRADING_SERVER_WALLET_ADDRESS) {
    return { key: null, problem: "TRADING_SERVER_WALLET_ADDRESS must be set alongside the secret key" };
  }
  let key: ServerWalletKey;
  try {
    key = parseServerWalletKey(env.TRADING_SERVER_WALLET_SECRET_KEY);
  } catch (err) {
    return { key: null, problem: err instanceof Error ? err.message : "the server wallet key is invalid" };
  }
  if (key.publicKey !== env.TRADING_SERVER_WALLET_ADDRESS) {
    key.seed.fill(0);
    return { key: null, problem: "the server wallet key does not belong to TRADING_SERVER_WALLET_ADDRESS" };
  }
  const withdrawTo = serverWithdrawTo(env);
  if (withdrawTo === key.publicKey) {
    key.seed.fill(0);
    return { key: null, problem: "TRADING_SERVER_WALLET_WITHDRAW_TO is the server wallet itself" };
  }
  return { key: { ...key, withdrawTo } };
}

/** The configured withdrawal destination, or null when withdrawals are off (or it's malformed). */
export function serverWithdrawTo(
  env: Pick<ServerWalletEnv, "TRADING_SERVER_WALLET_WITHDRAW_TO">,
): string | null {
  const to = env.TRADING_SERVER_WALLET_WITHDRAW_TO.trim();
  return to && looksLikeSolanaAddress(to) ? to : null;
}

/** The reserved account's id, created on first use. */
export async function ensureServerWalletAccount(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { walletAddress: SERVER_WALLET_ACCOUNT },
    create: { walletAddress: SERVER_WALLET_ACCOUNT },
    update: {},
    select: { id: true },
  });
  return user.id;
}
