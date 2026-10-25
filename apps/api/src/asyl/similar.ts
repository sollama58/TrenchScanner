import { prisma } from "@trenchscanner/core";
import type { TrackedWallet } from "../trackedWallets.js";
import { fundedEdge, GraphBuilder, hotFunders, loadCoTraders, transferEdge, type CoTrader } from "./graph.js";

/**
 * "Similar trades" (user ask 2026-10-24): the wallets that buy the same coins as this one within
 * minutes of it, and the coins those wallets bought that this one didn't, ranked by how many of
 * them did. Stored data only.
 */

/** Coins listed. */
export const SIMILAR_COINS_MAX = 20;

export interface SimilarCoin {
  mint: string;
  /** Co-traders that bought it. */
  buyers: number;
  firstBuyAt: string | null;
}

export async function loadSimilarCoins(
  wallet: string,
  coTraders: readonly CoTrader[],
): Promise<SimilarCoin[]> {
  const wallets = coTraders.map((c) => c.wallet);
  if (wallets.length === 0) return [];
  const rows = await prisma.$queryRaw<{ mint: string; buyers: number; first: Date | null }[]>`
    SELECT t."mintAddress" AS mint, COUNT(DISTINCT a."wallet")::int AS buyers, MIN(a."firstBuyAt") AS first
      FROM "TokenWalletActivity" a
      JOIN "Token" t ON t."id" = a."tokenId"
     WHERE a."wallet" = ANY(${wallets}) AND a."buys" > 0
       AND NOT EXISTS (
         SELECT 1 FROM "TokenWalletActivity" mine WHERE mine."tokenId" = a."tokenId" AND mine."wallet" = ${wallet}
       )
     GROUP BY t."mintAddress"
    HAVING COUNT(DISTINCT a."wallet") >= 2
     ORDER BY buyers DESC, first DESC NULLS LAST
     LIMIT ${SIMILAR_COINS_MAX}`;
  return rows.map((r) => ({ mint: r.mint, buyers: r.buyers, firstBuyAt: r.first?.toISOString() ?? null }));
}

/** Most labels drawn on "My labels". */
const LABELS_MAX = 250;
/** Probable sides drawn per label. */
const LABEL_SIDES = 3;

/**
 * The reader's own labeled wallets on one map (Pro Mode), tied wherever the tables tie them: the
 * same funder, one paying another, coins moved between them, and each label's strongest
 * Probable Sides.
 */
export async function labelsGraph(g: GraphBuilder, tracked: readonly TrackedWallet[]): Promise<void> {
  const wallets = tracked.slice(0, LABELS_MAX).map((t) => t.wallet);
  if (wallets.length === 0) return;
  for (const w of wallets) g.node(w, "wallet");
  const [funders, transfers, sides] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { wallet: { in: wallets }, status: "found" },
      select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
    }),
    prisma.$queryRaw<
      { fromWallet: string; toWallet: string; mintAddress: string; n: number; pct: number; last: Date }[]
    >`
      SELECT "fromWallet", "toWallet", "mintAddress", COUNT(*)::int AS n, SUM("pct")::float AS pct, MAX("at") AS last
        FROM "HolderTransferEvent"
       WHERE "fromWallet" = ANY(${wallets}) AND "toWallet" = ANY(${wallets})
       GROUP BY 1, 2, 3`,
    prisma.trackedWalletSide.findMany({
      where: { trackedWallet: { in: wallets } },
      orderBy: [{ pct: "desc" }, { shared: "desc" }],
    }),
  ]);
  const hot = await hotFunders(funders.flatMap((f) => (f.funder ? [f.funder] : [])));
  const onMap = new Set(wallets);
  const byFunder = new Map<string, typeof funders>();
  for (const f of funders)
    if (f.funder && !hot.has(f.funder)) byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), f]);
  for (const [funder, paid] of byFunder) {
    if (paid.length < 2 && !onMap.has(funder)) continue;
    g.node(funder, "wallet");
    for (const p of paid) fundedEdge(g, funder, p.wallet, p);
  }
  // The same lines as every other map draws: per coin, with its share of supply and date.
  for (const t of transfers) transferEdge(g, t, t.mintAddress);
  const perLabel = new Map<string, number>();
  for (const s of sides) {
    const n = perLabel.get(s.trackedWallet) ?? 0;
    if (n >= LABEL_SIDES) continue;
    perLabel.set(s.trackedWallet, n + 1);
    g.node(s.wallet, "wallet");
    g.edge({
      a: s.trackedWallet,
      b: s.wallet,
      kind: "side",
      weight: s.pct || 1,
      label:
        s.pct > 0
          ? `Probable Side · bought ${Math.round(s.pct)}% alongside`
          : `Probable Side · ${s.transfers} transfers`,
      source: "stored",
    });
  }
}
