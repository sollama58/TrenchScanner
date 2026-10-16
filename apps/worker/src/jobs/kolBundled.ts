import {
  bundledSupply,
  createLogger,
  kolBundledPct,
  prisma,
  type LinkedWalletsReading,
} from "@trenchscanner/core";

const logger = createLogger("kol-bundled");

/** A holder tied to a KOL: a possible side wallet (KolPossibleSide), or one the KOL funded. */
export interface KolTie {
  wallet: string;
  kolWallet: string;
}

/** The possible-side rows for these wallets (the hourly table the bubble map reads too). */
async function possibleSideTies(wallets: readonly string[]): Promise<KolTie[]> {
  if (wallets.length === 0) return [];
  return prisma.kolPossibleSide.findMany({
    where: { wallet: { in: [...wallets] } },
    select: { wallet: true, kolWallet: true },
  });
}

/** KOL Bundled % and Bundled % (linked holders and KOL bundles together) for one coin. */
export interface KolBundledReading {
  kolBundledPct: number;
  bundledSupplyPct: number;
  bundledSupplyCount: number;
  /**
   * The same two before a KOL's bundle followed its transfers (user decision 2026-10-16): what the
   * models and the AI judge keep reading until the next retrain (notes/model-retrain-pending.md).
   */
  kolBundledPctModel: number;
  bundledSupplyPctModel: number;
}

/** The holder lists a KOL reading needs: the linked reading's, or a stored snapshot's. */
export type KolBundledSource = Pick<LinkedWalletsReading, "holders" | "clusters" | "sameTimeClusters"> & {
  /** The coin's holder-to-holder transfers: a KOL's bundle takes in whoever it sent the coin to. */
  transfers?: readonly { from: string; to: string; pct: number }[] | null;
  /** The clusters funding alone forms, for a KOL's step out (core's KolBundledInput.kolClusters). */
  kolClusters?: LinkedWalletsReading["clusters"] | null;
};

/**
 * KOL Bundled % and Bundled % for each coin with a linked reading (core's wallets/kolBundled.ts), from the KOL
 * roster, the holders' funders (a holder a KOL funded is a KOL Funded Wallet) and one read of the
 * possible side wallets for every holder at once. Left off (unknown) for every coin while the
 * roster isn't loaded or that read fails, and for a coin without a reading.
 */
export async function kolBundledByMint(
  readings: ReadonlyMap<string, KolBundledSource | null>,
  funderOf: ReadonlyMap<string, string | null>,
  isKol: ((wallet: string) => boolean) | undefined,
  loadSides: (wallets: readonly string[]) => Promise<KolTie[]> = possibleSideTies,
): Promise<Map<string, KolBundledReading>> {
  const out = new Map<string, KolBundledReading>();
  if (!isKol) return out;
  const live = [...readings].filter((e): e is [string, KolBundledSource] => e[1] !== null);
  if (live.length === 0) return out;
  const wallets = [...new Set(live.flatMap(([, r]) => r.holders.map((h) => h.wallet)))];
  let sides: KolTie[];
  try {
    sides = await loadSides(wallets);
  } catch (err) {
    logger.warn("possible side wallets read failed - KOL Bundled % left unknown", { error: String(err) });
    return out;
  }
  const sidesOf = new Map<string, KolTie[]>();
  for (const t of sides) sidesOf.set(t.wallet, [...(sidesOf.get(t.wallet) ?? []), t]);
  for (const [mint, r] of live) {
    const ties: KolTie[] = [];
    for (const h of r.holders) {
      ties.push(...(sidesOf.get(h.wallet) ?? []));
      const funder = funderOf.get(h.wallet);
      // A KOL Funded Wallet; a KOL another KOL funded is a KOL in its own right, not a side.
      if (funder && funder !== h.wallet && isKol(funder) && !isKol(h.wallet))
        ties.push({ wallet: h.wallet, kolWallet: funder });
    }
    const input = {
      holders: r.holders,
      clusters: r.clusters,
      sameTimeClusters: r.sameTimeClusters,
      isKol,
      ties,
      transfers: r.transfers,
      kolClusters: r.kolClusters,
    };
    const bundled = bundledSupply(input);
    const unfollowed = { ...input, transfers: null, kolClusters: null };
    out.set(mint, {
      kolBundledPct: kolBundledPct(input),
      bundledSupplyPct: bundled.pct,
      bundledSupplyCount: bundled.count,
      kolBundledPctModel: kolBundledPct(unfollowed),
      bundledSupplyPctModel: bundledSupply(unfollowed).pct,
    });
  }
  return out;
}
