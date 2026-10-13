import { KNOWN_EXCHANGE_WALLETS, prisma, type HeliusIdentity } from "@trenchscanner/core";
import type { WalletIdentityReader } from "./walletIdentity.js";

/**
 * The name a holder list shows for a wallet in place of its address (POST /wallets/names): a
 * KOL's name from Solana Tracker's roster (KolWallet), else Helius's identity name, else
 * TrenchScanner's own exchange label. Read for a whole list at once.
 */

/** "pumpfun": Helius's name is a Pump.fun username, which the dashboard quotes and tints green. */
export type WalletNameSource = "kol" | "identity" | "pumpfun" | "exchange";

export interface WalletName {
  name: string;
  source: WalletNameSource;
}

/** The name a wallet goes by, highest priority first. Exported for tests. */
export function pickWalletName(input: {
  kol: string | null | undefined;
  identity: HeliusIdentity | null | undefined;
  exchange: string | null | undefined;
}): WalletName | null {
  const kol = input.kol?.trim();
  if (kol) return { name: kol, source: "kol" };
  const identity = input.identity?.name?.trim();
  if (identity) return { name: identity, source: input.identity?.pumpfun ? "pumpfun" : "identity" };
  const exchange = input.exchange?.trim();
  if (exchange) return { name: exchange, source: "exchange" };
  return null;
}

/** Names for the wallets that have one; wallets without a name are left out. */
export async function loadWalletNames(
  wallets: readonly string[],
  identity: WalletIdentityReader | null,
): Promise<Record<string, WalletName>> {
  const unique = [...new Set(wallets)];
  if (unique.length === 0) return {};
  const [kols, identities] = await Promise.all([
    prisma.kolWallet.findMany({ where: { wallet: { in: unique } }, select: { wallet: true, name: true } }),
    // Helius is asked only about wallets the KOL roster doesn't already name.
    identity ? identity.identities(unique).catch(() => new Map<string, HeliusIdentity | null>()) : null,
  ]);
  const kolName = new Map(kols.map((k) => [k.wallet, k.name]));
  const out: Record<string, WalletName> = {};
  for (const w of unique) {
    const name = pickWalletName({
      kol: kolName.get(w),
      identity: identities?.get(w),
      exchange: KNOWN_EXCHANGE_WALLETS.get(w),
    });
    if (name) out[w] = name;
  }
  return out;
}
