import { prisma } from "@trenchscanner/core";
import { GraphBuilder, fundedEdge, hotFunders } from "./graph.js";

/**
 * The common funder finder (user ask 2026-10-26): for two or more wallets, the nearest wallet that
 * paid for all of them, or for as many as one does, up their stored funding chains (WalletFunder).
 * Exchanges and other hot funders pay thousands of strangers, so a chain stops at one and it never
 * counts as shared. Database only, so free of credits; Find funders or Trace fills gaps first.
 */

/** Funders up each chain, at most. */
export const ANCESTRY_HOPS = 6;
/** Wallets one ask takes. */
export const COMMON_FUNDER_WALLETS = 50;

interface Link {
  funder: string;
  amountSol: number | null;
  fundedAt: Date | null;
}

export interface SharedFunder {
  funder: string;
  /** The wallets it paid for, directly or up their chain, and how many hops up it sits. */
  wallets: { wallet: string; hops: number }[];
}

export interface CommonFunderRead {
  /** The funder shared by the most wallets, nearest first; null when no two share one. */
  best: SharedFunder | null;
  /** Every funder two or more of them share, best first (at most 5). */
  shared: SharedFunder[];
  /** Each wallet's chain as stored: itself, its funder, that funder's funder... */
  chains: Record<string, string[]>;
  /** Where a chain ended at an exchange or service. */
  exchanges: string[];
}

/** Each wallet's funding chain, one indexed read per hop for all of them at once. */
async function chainsOf(
  wallets: readonly string[],
): Promise<{ chains: Map<string, string[]>; links: Map<string, Link>; hot: Set<string> }> {
  const chains = new Map(wallets.map((w) => [w, [w]]));
  const links = new Map<string, Link>();
  const hot = new Set<string>();
  let frontier = [...new Set(wallets)];
  for (let hop = 0; hop < ANCESTRY_HOPS && frontier.length; hop++) {
    const rows = await prisma.walletFunder.findMany({
      where: {
        wallet: { in: frontier.filter((w) => !links.has(w)) },
        status: "found",
        funder: { not: null },
      },
      select: { wallet: true, funder: true, amountSol: true, fundedAt: true },
    });
    for (const r of rows)
      links.set(r.wallet, { funder: r.funder!, amountSol: r.amountSol, fundedAt: r.fundedAt });
    for (const f of await hotFunders(rows.map((r) => r.funder!))) hot.add(f);
    const next = new Set<string>();
    for (const chain of chains.values()) {
      const end = chain[chain.length - 1]!;
      if (hot.has(end)) continue;
      const l = links.get(end);
      if (!l || chain.includes(l.funder)) continue;
      chain.push(l.funder);
      if (!hot.has(l.funder)) next.add(l.funder);
    }
    frontier = [...next];
  }
  return { chains, links, hot };
}

/** The funders two or more chains share, by how many wallets reach each, then how near it is. */
export function sharedFunders(
  chains: ReadonlyMap<string, string[]>,
  hot: ReadonlySet<string>,
): SharedFunder[] {
  const reach = new Map<string, { wallet: string; hops: number }[]>();
  for (const [wallet, chain] of chains)
    chain.forEach((f, hops) => {
      if (hops === 0 && !chains.has(f)) return;
      if (hot.has(f)) return;
      reach.set(f, [...(reach.get(f) ?? []), { wallet, hops }]);
    });
  const worst = (s: SharedFunder) => Math.max(...s.wallets.map((w) => w.hops));
  return (
    [...reach.entries()]
      .map(([funder, ws]) => ({ funder, wallets: ws }))
      // One of the asked wallets paying another counts: it reaches itself at hop 0.
      .filter((s) => s.wallets.filter((w) => w.wallet !== s.funder).length >= 1 && s.wallets.length >= 2)
      .sort((a, b) => b.wallets.length - a.wallets.length || worst(a) - worst(b))
  );
}

/**
 * The nearest funder the wallets share, drawn on the map: each wallet's chain up to it, and up to
 * the end of what is stored for the wallets it doesn't reach.
 */
export async function findCommonFunder(
  g: GraphBuilder,
  wallets: readonly string[],
): Promise<CommonFunderRead> {
  const { chains, links, hot } = await chainsOf(wallets);
  const shared = sharedFunders(chains, hot)
    // A funder only shared because a nearer shared one funded it adds nothing.
    .filter(
      (s, _, all) =>
        !all.some((o) => o !== s && o.wallets.length >= s.wallets.length && isBelow(o, s, chains)),
    )
    .slice(0, 5);
  const best = shared[0] ?? null;
  for (const [wallet, chain] of chains) {
    g.node(wallet, "wallet");
    const stopAt = best ? chain.indexOf(best.funder) : -1;
    const upTo = stopAt >= 0 ? stopAt : chain.length - 1;
    for (let i = 0; i < upTo; i++) {
      const from = chain[i + 1]!;
      g.node(from, "wallet", hot.has(from) ? { tags: ["exchange"] } : {});
      const l = links.get(chain[i]!);
      fundedEdge(g, from, chain[i]!, { amountSol: l?.amountSol ?? null, fundedAt: l?.fundedAt ?? null });
    }
  }
  return {
    best,
    shared,
    chains: Object.fromEntries(chains),
    exchanges: [...new Set([...chains.values()].map((c) => c[c.length - 1]!).filter((w) => hot.has(w)))],
  };
}

/** Whether `near` sits below `far` on every chain that reaches `far`. */
function isBelow(near: SharedFunder, far: SharedFunder, chains: ReadonlyMap<string, string[]>): boolean {
  return far.wallets.every((w) => {
    const chain = chains.get(w.wallet)!;
    const i = chain.indexOf(near.funder);
    return i >= 0 && i < w.hops;
  });
}

/** What the finder found, in a line. */
export function commonFunderNote(
  read: CommonFunderRead,
  asked: number,
  nameOf: (w: string) => string,
): string {
  const unread = Object.values(read.chains).filter((c) => c.length === 1).length;
  const gaps = unread
    ? ` ${unread} of them ${unread === 1 ? "has" : "have"} no stored funder: Find funders reads them from the chain.`
    : "";
  if (!read.best)
    return `No wallet paid for two or more of these ${asked} in TrenchScanner's records${
      read.exchanges.length
        ? `; ${read.exchanges.length === 1 ? "a chain ends" : "chains end"} at an exchange`
        : ""
    }.${gaps}`;
  const b = read.best;
  const far = Math.max(...b.wallets.map((w) => w.hops));
  const paid = b.wallets.filter((w) => w.wallet !== b.funder).length;
  const how = far <= 1 ? "directly" : `within ${far} hops`;
  return `${
    b.funder in read.chains
      ? `${nameOf(b.funder)}, one of them, paid for ${paid} of the others, ${how}`
      : `${nameOf(b.funder)} paid for ${paid} of the ${asked}, ${how}`
  }.${read.shared.length > 1 ? ` ${read.shared.length - 1} more shared funder${read.shared.length === 2 ? "" : "s"} found.` : ""}${gaps}`;
}
