import { prisma } from "@trenchscanner/core";

/**
 * Possible KOL side wallets (KolPossibleSide, rebuilt hourly by the worker's kolSideWalletsJob.ts):
 * wallets that, over the last 24 hours, bought more than 90% of a KOL's tracked coins within a few
 * minutes of it, on more than 25 coins (or all of them, on at least 10). For display only (the wallet modal's label, the bubble
 * map's ties); nothing scores or screens on it.
 */

export interface PossibleSide {
  kolWallet: string;
  /** The KOL's name on the roster, or null. */
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
}

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** "Ansem Possible Side (93%)": the label a possible side wallet carries. */
export function possibleSideText(s: Pick<PossibleSide, "kolWallet" | "kolName" | "pct">): string {
  return `${s.kolName ?? shortAddress(s.kolWallet)} Possible Side (${Math.round(s.pct)}%)`;
}

/** Each wallet's possible-side matches, strongest first; wallets with none are left out. */
export async function loadPossibleSides(wallets: readonly string[]): Promise<Record<string, PossibleSide[]>> {
  const unique = [...new Set(wallets)];
  if (unique.length === 0) return {};
  const rows = await prisma.kolPossibleSide.findMany({
    where: { wallet: { in: unique } },
    orderBy: [{ pct: "desc" }, { shared: "desc" }],
  });
  if (rows.length === 0) return {};
  const kols = await prisma.kolWallet.findMany({
    where: { wallet: { in: [...new Set(rows.map((r) => r.kolWallet))] } },
    select: { wallet: true, name: true },
  });
  const name = new Map(kols.map((k) => [k.wallet, k.name?.trim() || null]));
  const out: Record<string, PossibleSide[]> = {};
  for (const r of rows) {
    (out[r.wallet] ??= []).push({
      kolWallet: r.kolWallet,
      kolName: name.get(r.kolWallet) ?? null,
      pct: r.pct,
      shared: r.shared,
      kolCoins: r.kolCoins,
    });
  }
  return out;
}
