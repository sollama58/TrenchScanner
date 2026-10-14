import { prisma } from "@trenchscanner/core";

/**
 * Possible KOL side wallets (KolPossibleSide, refreshed hourly by the worker's kolSideWalletsJob.ts and
 * kept 90 days past the last run a wallet qualified): wallets that bought a KOL's tracked coins
 * within a few minutes of it, on one of core's POSSIBLE_SIDE_TIERS (all of them on 10+ coins over
 * 24 hours, 90%+ on 25+ over 48 hours, or 80%+ on 50+ over 72 hours). For display only (the wallet
 * modal's label, the bubble map's ties); nothing scores or screens on it.
 */

export interface PossibleSide {
  kolWallet: string;
  /** The KOL's name on the roster, or null. */
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
  /** The span the match was read over: 24, 48 or 72 hours (36 on labels from before 2026-10-14). */
  hours: number;
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
      hours: r.hours,
    });
  }
  return out;
}
