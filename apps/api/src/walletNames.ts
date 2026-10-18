import {
  cleanWalletName,
  isServiceWallet,
  KNOWN_EXCHANGE_WALLETS,
  PLATFORM_WALLETS,
  prisma,
  withoutHandle,
  type HeliusIdentity,
} from "@trenchscanner/core";
import type { IdentityUserKey, WalletIdentityReader } from "./walletIdentity.js";
import { knownSideName, readKolRows } from "./kolRoster.js";

/**
 * The name a holder list shows for a wallet in place of its address (POST /wallets/names): a
 * KOL's name from Solana Tracker's roster (KolWallet), else Helius's identity name, else
 * TrenchScanner's own exchange label; a launchpad's own wallet (core's PLATFORM_WALLETS,
 * "Stonk_Fees") goes by TrenchScanner's label above all. Read for a whole list at once. A KOL's
 * Known Side (another roster wallet of a KOL whose main wallet is set, core's KOL_MAINS) is
 * "<KOL> Known Side".
 */

/**
 * "pumpfun": Helius's name is a Pump.fun username, which the dashboard quotes and tints green;
 * "fomo": a FOMO app username, quoted and tinted purple; "kol-side": a KOL's Known Side;
 * "tracked": a wallet the reader labeled as User Tracked (trackedWallets.ts; a label marked KOL is
 * "kol"), for that reader alone.
 */
export type WalletNameSource = "kol" | "kol-side" | "identity" | "pumpfun" | "fomo" | "exchange" | "tracked";

export interface WalletName {
  name: string;
  source: WalletNameSource;
  /**
   * An exchange or launchpad wallet (core's isServiceWallet), whatever name it goes by: never a
   * person, so the bubble map's KOL bundles skip its transfers. Absent otherwise.
   */
  service?: true;
  /** The reader's own label (trackedWallets.ts), which they can edit; absent on every other name. */
  mine?: true;
}

/** The name a wallet goes by, highest priority first. Exported for tests. */
export function pickWalletName(input: {
  kol: string | null | undefined;
  /** "Cupsey Known Side", on a KOL's Known Side. */
  kolSide?: string | null;
  identity: HeliusIdentity | null | undefined;
  exchange: string | null | undefined;
  /** TrenchScanner's own label for a launchpad's wallet ("Stonk_Fees"): above every other name. */
  platform?: string | null;
}): WalletName | null {
  if (input.platform) return { name: input.platform, source: "exchange" };
  // Every name drops a trailing X handle ("NAME @HANDLE" → "NAME", user ask 2026-10-16); an
  // identity read before that was cached with it, so it is cleaned again here.
  const kolSide = input.kolSide && withoutHandle(input.kolSide);
  if (kolSide) return { name: kolSide, source: "kol-side" };
  const kol = input.kol && withoutHandle(input.kol);
  if (kol) return { name: kol, source: "kol" };
  const identity = input.identity?.name && cleanWalletName(input.identity.name);
  if (identity)
    return {
      name: identity,
      source: input.identity?.pumpfun ? "pumpfun" : input.identity?.fomo ? "fomo" : "identity",
    };
  const exchange = input.exchange && withoutHandle(input.exchange);
  if (exchange) return { name: exchange, source: "exchange" };
  return null;
}

/**
 * Which of `wallets` TrenchScanner has come across: a holder whose age or funder a scan read, a
 * funder of one, a trader on a read trade tape, or a wallet with a risk score. Helius is asked only
 * about these, so a list of random addresses costs nothing. Indexed lookups only.
 */
export async function seenWallets(wallets: readonly string[]): Promise<Set<string>> {
  if (wallets.length === 0) return new Set();
  const list = [...wallets];
  const rows = await prisma.$queryRaw<{ wallet: string }[]>`
    SELECT "wallet" FROM "WalletFunder" WHERE "wallet" = ANY(${list})
    UNION SELECT "funder" FROM "WalletFunder" WHERE "funder" = ANY(${list})
    UNION SELECT "address" FROM "WalletActivityCache" WHERE "address" = ANY(${list})
    UNION SELECT "address" FROM "WalletHoldingsCache" WHERE "address" = ANY(${list})
    UNION SELECT "wallet" FROM "WalletRisk" WHERE "wallet" = ANY(${list})
    UNION SELECT DISTINCT "wallet" FROM "TokenWalletActivity" WHERE "wallet" = ANY(${list})`;
  return new Set(rows.map((r) => r.wallet));
}

export interface WalletNamesRead {
  /** Names for the wallets that have one; wallets without a name are left out. */
  names: Record<string, WalletName>;
  /**
   * Wallets Helius would be asked about but wasn't, this time (the minute's or the account's
   * budget ran out): not "no name", so the dashboard asks again later.
   */
  unread: string[];
}

export async function loadWalletNames(
  wallets: readonly string[],
  identity: WalletIdentityReader | null,
  user?: IdentityUserKey,
): Promise<WalletNamesRead> {
  const unique = [...new Set(wallets)];
  if (unique.length === 0) return { names: {}, unread: [] };
  const kols = await readKolRows(unique);
  const kolName = new Map(
    [...kols.values()].flatMap((k) =>
      k.main ? [[k.wallet, knownSideName(k.main)] as const] : k.name ? [[k.wallet, k.name] as const] : [],
    ),
  );
  // Helius is asked only about wallets the KOL roster doesn't name, and only those TrenchScanner
  // has seen.
  const unnamed = unique.filter((w) => !kolName.has(w));
  const ask = identity && unnamed.length > 0 ? [...(await seenWallets(unnamed))] : [];
  const identities =
    identity && ask.length > 0
      ? await identity.identities(ask, Date.now(), user).catch(() => new Map<string, HeliusIdentity | null>())
      : new Map<string, HeliusIdentity | null>();
  const names: Record<string, WalletName> = {};
  for (const w of unique) {
    const name = pickWalletName({
      kol: kols.get(w)?.main ? null : kolName.get(w),
      kolSide: kols.get(w)?.main ? kolName.get(w) : null,
      identity: identities.get(w),
      exchange: KNOWN_EXCHANGE_WALLETS.get(w),
      platform: PLATFORM_WALLETS.get(w),
    });
    if (name) names[w] = isServiceWallet(w) ? { ...name, service: true } : name;
  }
  return { names, unread: ask.filter((w) => !identities.has(w)) };
}
