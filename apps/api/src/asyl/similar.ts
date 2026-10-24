import { prisma } from "@trenchscanner/core";
import type { TrackedWallet } from "../trackedWallets.js";
import { GraphBuilder, hotFunders, loadCoTraders, type CoTrader } from "./graph.js";

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
    prisma.$queryRaw<{ fromWallet: string; toWallet: string; n: number; pct: number; last: Date }[]>`
      SELECT "fromWallet", "toWallet", COUNT(*)::int AS n, SUM("pct")::float AS pct, MAX("at") AS last
        FROM "HolderTransferEvent"
       WHERE "fromWallet" = ANY(${wallets}) AND "toWallet" = ANY(${wallets})
       GROUP BY 1, 2`,
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
    for (const p of paid)
      g.edge({
        a: funder,
        b: p.wallet,
        kind: "funded",
        weight: p.amountSol ?? 0.01,
        label: `Funded${p.amountSol ? ` ${p.amountSol.toPrecision(2)} SOL` : ""}`,
        source: "stored",
        at: p.fundedAt?.toISOString() ?? null,
        sol: p.amountSol,
      });
  }
  for (const t of transfers)
    g.edge({
      a: t.fromWallet,
      b: t.toWallet,
      kind: "transfer",
      weight: t.pct,
      label: `Sent coins ${t.n}×`,
      source: "stored",
      at: t.last.toISOString(),
      pct: t.pct,
    });
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
