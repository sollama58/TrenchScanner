import { prisma } from "@trenchscanner/core";

/**
 * Possible KOL side wallets (KolPossibleSide, refreshed hourly by the worker's kolSideWalletsJob.ts and
 * kept 90 days past the last run a wallet qualified): wallets that bought a KOL's tracked coins
 * within a few minutes of it, on one of core's POSSIBLE_SIDE_TIERS (all of them on 10+ coins over
 * 24 hours, 90%+ on 25+ over 48 hours, or 80%+ on 50+ over 72 hours). For display only (the wallet
 * modal's label, the bubble map's ties); nothing scores or screens on it.
 *
 * A wallet a KOL funded (WalletFunder.funder is the KOL: the KOL paid for its first SOL) is a KOL
 * Funded Wallet (user ask 2026-10-14): read here from the funder table, whatever its trades, and
 * shown without the "possible".
 */

export interface PossibleSide {
  kolWallet: string;
  /** The KOL's name on the roster, or null. */
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
  /** The span the match was read over: 24, 48 or 72 hours (36 on labels from before 2026-10-14); 0 on a funded-only entry. */
  hours: number;
  /** The KOL funded this wallet; then pct/shared/kolCoins are its trade match, or 0 when it has none. */
  funded?: boolean;
  /** When the funding landed and how much, on a funded entry. */
  fundedAt?: Date | null;
  fundedSol?: number | null;
}

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** "Ansem Possible Side (93%)", or "Ansem KOL Funded Wallet": the label the wallet carries. */
export function possibleSideText(
  s: Pick<PossibleSide, "kolWallet" | "kolName" | "pct"> & { funded?: boolean },
): string {
  const who = s.kolName ?? shortAddress(s.kolWallet);
  return s.funded ? `${who} KOL Funded Wallet` : `${who} Possible Side (${Math.round(s.pct)}%)`;
}

/** Each wallet's possible-side matches, strongest first; wallets with none are left out. */
export async function loadPossibleSides(wallets: readonly string[]): Promise<Record<string, PossibleSide[]>> {
  const unique = [...new Set(wallets)];
  if (unique.length === 0) return {};
  const [rows, fundedRows] = await Promise.all([
    prisma.kolPossibleSide.findMany({
      where: { wallet: { in: unique } },
      orderBy: [{ pct: "desc" }, { shared: "desc" }],
    }),
    kolFunded(unique),
  ]);
  if (rows.length === 0 && fundedRows.length === 0) return {};
  const kols = await prisma.kolWallet.findMany({
    where: { wallet: { in: [...new Set([...rows, ...fundedRows].map((r) => r.kolWallet))] } },
    select: { wallet: true, name: true },
  });
  const name = new Map(kols.map((k) => [k.wallet, k.name?.trim() || null]));
  const out: Record<string, PossibleSide[]> = {};
  // Funded first: it is the stronger tie. A trade match for the same KOL rides on the same entry.
  for (const f of fundedRows) {
    const match = rows.find((r) => r.wallet === f.wallet && r.kolWallet === f.kolWallet);
    (out[f.wallet] ??= []).push({
      kolWallet: f.kolWallet,
      kolName: name.get(f.kolWallet) ?? null,
      pct: match?.pct ?? 0,
      shared: match?.shared ?? 0,
      kolCoins: match?.kolCoins ?? 0,
      hours: match?.hours ?? 0,
      funded: true,
      fundedAt: f.fundedAt,
      fundedSol: f.amountSol,
    });
  }
  for (const r of rows) {
    if (out[r.wallet]?.some((s) => s.funded && s.kolWallet === r.kolWallet)) continue;
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

/** The wallets among `wallets` a roster KOL funded (paid for their first SOL), KOLs themselves aside. */
async function kolFunded(
  wallets: readonly string[],
): Promise<{ wallet: string; kolWallet: string; fundedAt: Date | null; amountSol: number | null }[]> {
  const rows = await prisma.$queryRaw<
    { wallet: string; kolWallet: string; fundedAt: Date | null; amountSol: number | null }[]
  >`
    SELECT f."wallet", f."funder" AS "kolWallet", f."fundedAt", f."amountSol"
    FROM "WalletFunder" f
    JOIN "KolWallet" k ON k."wallet" = f."funder"
    WHERE f."wallet" = ANY(${[...wallets]})
      AND f."funder" <> f."wallet"
      AND NOT EXISTS (SELECT 1 FROM "KolWallet" k2 WHERE k2."wallet" = f."wallet")`;
  return rows;
}
