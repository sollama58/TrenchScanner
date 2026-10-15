/**
 * KOL Bundled % (user ask 2026-10-14): the share of supply KOLs hold through bundles among the top
 * holders. A KOL counts when at least one other holder is tied to it: a wallet the KOL funded (a
 * KOL Funded Wallet), a possible side wallet (KolPossibleSide), or a holder sharing a funder
 * cluster or a funding minute with the KOL's own wallet or one of those. One step out, no further
 * (user decision 2026-10-14). Each holder counts once across every KOL; a KOL holding alone, tied
 * to no one, adds nothing. The bubble map's KOLs list (apps/web bubbleMap.ts kolControl) draws the
 * same groups.
 */

export interface KolBundledInput {
  /** The top holders the linked reading covers, with their share of supply, %. */
  holders: readonly { wallet: string; pct: number }[];
  /** Funder clusters among them (linkedWallets' clusters). */
  clusters: readonly { wallets: readonly { wallet: string }[] }[];
  /** Same-minute funding groups among them (linkedWallets' sameTimeClusters). */
  sameTimeClusters: readonly { wallets: readonly { wallet: string }[] }[];
  /** Whether a wallet is on the KOL roster. */
  isKol: (wallet: string) => boolean;
  /** Holders tied to a KOL: the KOL funded them, or they trade as its possible side wallet. */
  ties: readonly { wallet: string; kolWallet: string }[];
}

/** The holders KOL Bundled % takes in: every KOL bundle's, each once. */
export function kolBundledWallets(input: KolBundledInput): Set<string> {
  const pctOf = new Map(input.holders.map((h) => [h.wallet, h.pct]));
  // Each holder's groups: the cluster and the same-minute group it sits in.
  const groupsOf = new Map<string, string[][]>();
  for (const g of [...input.clusters, ...input.sameTimeClusters]) {
    const members = g.wallets.map((w) => w.wallet).filter((w) => pctOf.has(w));
    for (const w of members) {
      const list = groupsOf.get(w) ?? [];
      list.push(members);
      groupsOf.set(w, list);
    }
  }
  const tiedByKol = new Map<string, Set<string>>();
  for (const t of input.ties) {
    if (!pctOf.has(t.wallet) || t.wallet === t.kolWallet) continue;
    const set = tiedByKol.get(t.kolWallet) ?? new Set<string>();
    set.add(t.wallet);
    tiedByKol.set(t.kolWallet, set);
  }
  for (const w of pctOf.keys()) if (input.isKol(w) && !tiedByKol.has(w)) tiedByKol.set(w, new Set());
  const bundled = new Set<string>();
  for (const [kol, tied] of tiedByKol) {
    const core = new Set(tied);
    if (pctOf.has(kol)) core.add(kol);
    const reach = new Set(core);
    for (const w of core) for (const g of groupsOf.get(w) ?? []) for (const o of g) reach.add(o);
    // Tied to no one but itself: not a bundle.
    if ([...reach].every((w) => w === kol)) continue;
    for (const w of reach) bundled.add(w);
  }
  return bundled;
}

const sumOf = (wallets: Iterable<string>, holders: readonly { wallet: string; pct: number }[]) => {
  const pctOf = new Map(holders.map((h) => [h.wallet, h.pct]));
  let sum = 0;
  for (const w of wallets) sum += pctOf.get(w) ?? 0;
  return Math.round(sum * 100) / 100;
};

/** KOL Bundled %, rounded to 2 places; 0 when no KOL bundles any supply. */
export function kolBundledPct(input: KolBundledInput): number {
  return sumOf(kolBundledWallets(input), input.holders);
}

/**
 * Bundled % (user ask 2026-10-15): the top holders that are linked (in a funder cluster or a
 * same-minute group, linkedWallets' Linked) or in a KOL's bundle, each once: the alert card's
 * Linked tile and the bubble map's Linked count the same holders over the scan's top 25. `count`
 * is how many holders, of the reading's holders. A separate input and filter: the linked
 * figures (linkedWalletPct, linkedWalletCount) keep leaving KOL bundles out.
 */
export function bundledSupply(input: KolBundledInput): { pct: number; count: number } {
  const holders = new Set(input.holders.map((h) => h.wallet));
  const wallets = kolBundledWallets(input);
  for (const g of [...input.clusters, ...input.sameTimeClusters])
    for (const w of g.wallets) if (holders.has(w.wallet)) wallets.add(w.wallet);
  return { pct: sumOf(wallets, input.holders), count: wallets.size };
}
