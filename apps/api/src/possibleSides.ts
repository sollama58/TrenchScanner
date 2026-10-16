import { MARKED_BOT_WALLETS, prisma } from "@trenchscanner/core";
import { readKolRows } from "./kolRoster.js";

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
 *
 * A KOL's Known Side (KolWallet.mainWallet, core's KOL_MAINS) carries a `known` entry for its KOL's
 * main wallet, ahead of any other; and a match or funding by a Known Side counts as its KOL's.
 */

export interface PossibleSide {
  kolWallet: string;
  /** The KOL's name on the roster, or null. */
  kolName: string | null;
  pct: number;
  shared: number;
  kolCoins: number;
  /** The span the match was read over: 24, 48 or 72 hours; 0 on a funded-only entry. */
  hours: number;
  /** The KOL funded this wallet; then pct/shared/kolCoins are its trade match, or 0 when it has none. */
  funded?: boolean;
  /** When the funding landed and how much, on a funded entry. */
  fundedAt?: Date | null;
  fundedSol?: number | null;
  /** A Known Side: one of the KOL's own wallets, named as such (KolWallet.mainWallet). */
  known?: boolean;
  /**
   * Transfers of a coin between it and the KOL that earned the label (user ask 2026-10-16: core's
   * TRANSFER_SIDE_OUTBOUND_TIERS and TRANSFER_SIDE_INBOUND_TIERS), in that span; absent when buying
   * alongside earned it alone.
   */
  transfers?: number;
}

const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/** "Ansem Possible Side (93%)", "Ansem KOL Funded Wallet" or "Ansem Known Side": the label the wallet carries. */
export function possibleSideText(
  s: Pick<PossibleSide, "kolWallet" | "kolName" | "pct"> & {
    funded?: boolean;
    known?: boolean;
    transfers?: number;
  },
): string {
  const who = s.kolName ?? shortAddress(s.kolWallet);
  if (s.known) return `${who} Known Side`;
  if (s.funded) return `${who} KOL Funded Wallet`;
  // A label transfers alone earned has no buying-alongside share to show.
  return s.pct > 0
    ? `${who} Possible Side (${Math.round(s.pct)}%)`
    : `${who} Possible Side (${s.transfers ?? 0} transfers)`;
}

/** Each wallet's possible-side matches, strongest first; wallets with none are left out. */
export async function loadPossibleSides(wallets: readonly string[]): Promise<Record<string, PossibleSide[]>> {
  // A wallet marked as a bot is no one's side, whatever ties it has.
  const unique = [...new Set(wallets)].filter((w) => !MARKED_BOT_WALLETS.has(w));
  if (unique.length === 0) return {};
  const [rows, fundedRows] = await Promise.all([
    prisma.kolPossibleSide.findMany({
      where: { wallet: { in: unique } },
      orderBy: [{ pct: "desc" }, { shared: "desc" }],
    }),
    kolFunded(unique),
  ]);
  const kols = await readKolRows([...unique, ...[...rows, ...fundedRows].map((r) => r.kolWallet)]);
  // A Known Side's match or funding is its KOL's: keyed by the main wallet.
  const kolOf = (w: string) => {
    const k = kols.get(w);
    return k?.main ? { wallet: k.main.wallet, name: k.main.name } : { wallet: w, name: k?.name ?? null };
  };
  const out: Record<string, PossibleSide[]> = {};
  const has = (wallet: string, kolWallet: string) => out[wallet]?.some((s) => s.kolWallet === kolWallet);
  // Known Sides first: the KOL's own wallet, not a guess.
  for (const w of unique) {
    const main = kols.get(w)?.main;
    if (!main || main.wallet === w) continue;
    (out[w] ??= []).push({
      kolWallet: main.wallet,
      kolName: main.name,
      pct: 100,
      shared: 0,
      kolCoins: 0,
      hours: 0,
      known: true,
    });
  }
  // Funded next: it is the stronger tie. A trade match for the same KOL rides on the same entry.
  for (const f of fundedRows) {
    const kol = kolOf(f.kolWallet);
    if (kol.wallet === f.wallet || has(f.wallet, kol.wallet)) continue;
    const match = rows.find((r) => r.wallet === f.wallet && r.kolWallet === f.kolWallet);
    (out[f.wallet] ??= []).push({
      kolWallet: kol.wallet,
      kolName: kol.name,
      pct: match?.pct ?? 0,
      shared: match?.shared ?? 0,
      kolCoins: match?.kolCoins ?? 0,
      hours: match?.hours ?? 0,
      ...(match?.transfers ? { transfers: match.transfers } : {}),
      funded: true,
      fundedAt: f.fundedAt,
      fundedSol: f.amountSol,
    });
  }
  for (const r of rows) {
    const kol = kolOf(r.kolWallet);
    if (kol.wallet === r.wallet || has(r.wallet, kol.wallet)) continue;
    (out[r.wallet] ??= []).push({
      kolWallet: kol.wallet,
      kolName: kol.name,
      pct: r.pct,
      shared: r.shared,
      kolCoins: r.kolCoins,
      hours: r.hours,
      ...(r.transfers > 0 ? { transfers: r.transfers } : {}),
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

/** One wallet with a side label, under the KOL it is strongest for, numbered within that KOL. */
export interface LabeledSide {
  wallet: string;
  kolWallet: string;
  kolName: string | null;
  kind: "known" | "funded" | "possible";
  /** % shared on a Possible Side; 100 on a Known Side; the trade match (or 0) on a funded one. */
  pct: number;
  /** "Cupsey_1": the KOL's name (spaces and commas as underscores) and the wallet's number under it. */
  name: string;
  /** Transfers with the KOL that earned a Possible Side label (core's TRANSFER_SIDE_OUTBOUND_TIERS and TRANSFER_SIDE_INBOUND_TIERS); absent when none. */
  transfers?: number;
}

const KIND_RANK: Record<LabeledSide["kind"], number> = { known: 0, funded: 1, possible: 2 };
const kindOf = (s: PossibleSide): LabeledSide["kind"] =>
  s.known ? "known" : s.funded ? "funded" : "possible";
const nameStem = (kolWallet: string, kolName: string | null) =>
  (kolName?.trim() || kolWallet.slice(0, 6)).replace(/[\s,]+/g, "_");

/**
 * Numbers each wallet's strongest label within its KOL (user ask 2026-10-14, the Side Wallet
 * Checker's export): Known Sides first, then funded wallets, then Possible Sides by % shared. KOLs
 * in name order, so the list reads grouped. Exported for tests.
 */
export function numberLabeledSides(sides: Record<string, PossibleSide[]>): LabeledSide[] {
  const byKol = new Map<string, Omit<LabeledSide, "name">[]>();
  for (const [wallet, entries] of Object.entries(sides)) {
    const top = entries[0];
    if (!top) continue;
    const list = byKol.get(top.kolWallet) ?? [];
    list.push({
      wallet,
      kolWallet: top.kolWallet,
      kolName: top.kolName,
      kind: kindOf(top),
      pct: top.pct,
      ...(top.transfers ? { transfers: top.transfers } : {}),
    });
    byKol.set(top.kolWallet, list);
  }
  const groups = [...byKol.values()].sort((a, b) => {
    const an = nameStem(a[0]!.kolWallet, a[0]!.kolName).toLowerCase();
    const bn = nameStem(b[0]!.kolWallet, b[0]!.kolName).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : a[0]!.kolWallet < b[0]!.kolWallet ? -1 : 1;
  });
  return groups.flatMap((list) =>
    list
      .sort(
        (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.pct - a.pct || (a.wallet < b.wallet ? -1 : 1),
      )
      .map((s, i) => ({ ...s, name: `${nameStem(s.kolWallet, s.kolName)}_${i + 1}` })),
  );
}

/**
 * Every wallet that carries a side label today: a Possible Side (KolPossibleSide, which already
 * leaves bots and likely bots out), a KOL's Known Side, or a wallet a KOL funded. Each is counted
 * once, under the KOL its strongest label names (loadPossibleSides' order).
 */
export async function loadLabeledSides(): Promise<LabeledSide[]> {
  return numberLabeledSides(await loadPossibleSides(await labeledCandidates()));
}

/**
 * How many wallets are labeled for each KOL (user ask 2026-10-16: the leaderboard's "N Flagged
 * Wallets"), keyed by its main wallet: the same wallets loadKolSideLabels pins above its list, so a
 * wallet labeled for two KOLs counts for both.
 */
export async function loadKolLabelCounts(): Promise<Map<string, number>> {
  return countKolLabels(await loadPossibleSides(await labeledCandidates()));
}

/** loadKolLabelCounts' pure half: each KOL's labeled wallets, once each. Exported for tests. */
export function countKolLabels(sides: Record<string, PossibleSide[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entries of Object.values(sides)) {
    for (const kol of new Set(entries.map((e) => e.kolWallet))) counts.set(kol, (counts.get(kol) ?? 0) + 1);
  }
  return counts;
}

/** Every wallet that may carry a side label: Possible Sides, Known Sides, and wallets a KOL funded. */
async function labeledCandidates(): Promise<string[]> {
  const [possible, known, funded] = await Promise.all([
    prisma.kolPossibleSide.findMany({ select: { wallet: true } }),
    prisma.kolWallet.findMany({
      where: { mainWallet: { not: null } },
      select: { wallet: true, mainWallet: true },
    }),
    prisma.$queryRaw<{ wallet: string }[]>`
      SELECT DISTINCT f."wallet"
      FROM "WalletFunder" f
      JOIN "KolWallet" k ON k."wallet" = f."funder"
      WHERE f."funder" <> f."wallet"
        AND NOT EXISTS (SELECT 1 FROM "KolWallet" k2 WHERE k2."wallet" = f."wallet")`,
  ]);
  return [
    ...possible.map((r) => r.wallet),
    ...known.filter((k) => k.mainWallet !== k.wallet).map((k) => k.wallet),
    ...funded.map((r) => r.wallet),
  ];
}

/**
 * One KOL's labeled sides, as the export numbers them (user ask 2026-10-15, the wallet modal under
 * its first funder): `wallet` is the KOL's main wallet or one of its Known Sides, read as its KOL.
 * Known Sides, the wallets it or a Known Side funded, and its Possible Sides; each wallet whose
 * strongest label names another KOL is left to that KOL, as in the export.
 */
export async function loadKolLabeledSides(wallet: string): Promise<LabeledSide[]> {
  const read = await readKolGroupSides(wallet);
  if (!read) return [];
  return numberLabeledSides(read.sides).filter((s) => s.kolWallet === read.main);
}

/** A KOL's group (its main wallet and Known Sides) and every label any of them earned, keyed by wallet. */
async function readKolGroupSides(
  wallet: string,
): Promise<{ main: string; sides: Record<string, PossibleSide[]> } | null> {
  const own = await prisma.kolWallet.findUnique({ where: { wallet }, select: { mainWallet: true } });
  if (!own) return null;
  const main = own.mainWallet ?? wallet;
  const known = await prisma.kolWallet.findMany({ where: { mainWallet: main }, select: { wallet: true } });
  const group = [main, ...known.map((k) => k.wallet).filter((w) => w !== main)];
  const [funded, possible] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { funder: { in: group }, status: "found", wallet: { notIn: group } },
      select: { wallet: true },
    }),
    prisma.kolPossibleSide.findMany({ where: { kolWallet: { in: group } }, select: { wallet: true } }),
  ]);
  const wallets = [
    ...group.filter((w) => w !== main),
    ...funded.map((r) => r.wallet),
    ...possible.map((r) => r.wallet),
  ];
  return { main, sides: await loadPossibleSides(wallets) };
}

/** A wallet carrying a label for one KOL, as the Side Wallet Checker pins it above the KOL's list. */
export interface KolSideLabel {
  wallet: string;
  kind: LabeledSide["kind"];
  /** % shared on the tier that earned it; 100 on a Known Side; 0 when transfers or funding alone did. */
  pct: number;
  /** The tier's span: 24, 48 or 72 hours; 0 on a Known Side or a funded-only entry. */
  hours: number;
  /** Transfers with the KOL that earned (or helped earn) the label; absent when none. */
  transfers?: number;
  /** Its name in the export ("Cupsey_2"), or null when its strongest label is another KOL's. */
  name: string | null;
}

/**
 * Every wallet labeled for this KOL (user ask 2026-10-16: pinned above the KOL's side-wallet list
 * whatever the window): its Known Sides, the wallets it funded and its Possible Sides, buying or
 * transfers. Unlike the export, a wallet whose strongest label names another KOL is kept too: it
 * is labeled for this one as well. Known Sides first, then funded, then by % shared and transfers.
 * `wallet` itself is left out (a Known Side's list is its KOL's labels less itself).
 */
export async function loadKolSideLabels(wallet: string): Promise<KolSideLabel[]> {
  const read = await readKolGroupSides(wallet);
  if (!read) return [];
  return kolSideLabels(wallet, read.main, read.sides, numberLabeledSides(read.sides));
}

/** loadKolSideLabels' pure half. Exported for tests. */
export function kolSideLabels(
  wallet: string,
  main: string,
  sides: Record<string, PossibleSide[]>,
  numbered: readonly LabeledSide[],
): KolSideLabel[] {
  const names = new Map(numbered.filter((n) => n.kolWallet === main).map((n) => [n.wallet, n.name]));
  const out: KolSideLabel[] = [];
  for (const [w, entries] of Object.entries(sides)) {
    if (w === wallet) continue;
    const s = entries.find((e) => e.kolWallet === main);
    if (!s) continue;
    out.push({
      wallet: w,
      kind: kindOf(s),
      pct: s.pct,
      hours: s.hours,
      ...(s.transfers ? { transfers: s.transfers } : {}),
      name: names.get(w) ?? null,
    });
  }
  return out.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.pct - a.pct ||
      (b.transfers ?? 0) - (a.transfers ?? 0) ||
      (a.wallet < b.wallet ? -1 : 1),
  );
}
