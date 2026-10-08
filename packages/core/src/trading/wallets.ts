import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { generateWalletKeypair, openWalletSecret, sealWalletSecret, type KeyProvider } from "./keyVault.js";

/**
 * Creating a user's trading wallet, and borrowing its key for one signature.
 *
 * The seed exists in plaintext only inside these functions and is zeroed before they return.
 * Nothing here ever returns, logs or stores it unsealed.
 */

export type TradingWalletRow = Prisma.TradingWalletGetPayload<object>;

/** The user's wallet, created (and sealed) on first call. Idempotent under a race: one row wins. */
export async function ensureTradingWallet(userId: string, provider: KeyProvider): Promise<TradingWalletRow> {
  const existing = await prisma.tradingWallet.findUnique({ where: { userId } });
  if (existing) return existing;
  const { seed, publicKey } = generateWalletKeypair();
  try {
    const sealed = await sealWalletSecret(provider, seed, { userId, publicKey });
    return await prisma.tradingWallet.create({ data: { userId, publicKey, ...sealed } });
  } catch (err) {
    // Two requests at once: the other one's wallet stands, this key is discarded unused.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.tradingWallet.findUnique({ where: { userId } });
      if (winner) return winner;
    }
    throw err;
  } finally {
    seed.fill(0);
  }
}

/** Opens the wallet's key for `use` and zeroes it afterwards, however `use` ends. */
export async function withWalletKey<T>(
  wallet: Pick<
    TradingWalletRow,
    | "userId"
    | "publicKey"
    | "secretCiphertext"
    | "secretIv"
    | "secretAuthTag"
    | "wrappedDataKey"
    | "keyProvider"
  >,
  provider: KeyProvider,
  use: (seed: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const seed = await openWalletSecret(provider, wallet, {
    userId: wallet.userId,
    publicKey: wallet.publicKey,
  });
  try {
    return await use(seed);
  } finally {
    seed.fill(0);
  }
}
