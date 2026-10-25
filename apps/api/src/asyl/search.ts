import { prisma, type Prisma } from "@trenchscanner/core";
import { matchRank } from "../tokenSearch.js";
import { tokenTextWhere } from "../routes/matches.js";
import type { TrackedWallet } from "../trackedWallets.js";
import { loadWalletNames } from "../walletNames.js";

/**
 * Asyl's search box (user ask 2026-10-25): coins TrenchScanner tracks by ticker, name or address,
 * roster KOLs by name, X handle or address, and the reader's own labeled wallets, best match first.
 * A pasted address still maps directly; this is for finding one by name. Stored data only.
 */

export const SEARCH_TOKENS_SHOWN = 8;
export const SEARCH_WALLETS_SHOWN = 8;
/** Coins read before ranking: the newest this many that hold the text. */
const SEARCH_TOKENS_READ = 80;

export interface SearchToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  mcapUsd: number | null;
  launchedAt: string | null;
}

export interface SearchWallet {
  wallet: string;
  name: string;
  kind: "kol" | "label";
  twitter: string | null;
  avatar: string | null;
  winRate: number | null;
  pnlUsd: number | null;
}

export interface SearchRead {
  q: string;
  tokens: SearchToken[];
  wallets: SearchWallet[];
}

/** Coins that aren't only someone's paid lookup: the scanner's own, as the feed's search keeps. */
const TRACKED: Prisma.TokenWhereInput = {
  OR: [
    { discoverySource: null },
    { discoverySource: { not: "utility" } },
    { matches: { some: {} } },
    { curatedAlerts: { some: {} } },
  ],
};

/** How well a wallet's name, handle or address answers the text: lower is better. */
export function walletRank(text: string, name: string, twitter: string | null, wallet: string): number {
  const t = text.toLowerCase().replace(/^@/, "");
  const n = name.toLowerCase();
  const h = twitter?.toLowerCase() ?? "";
  if (n === t || h === t) return 0;
  if (n.startsWith(t) || h.startsWith(t)) return 1;
  if (n.split(/\s+/).some((w) => w.startsWith(t))) return 2;
  if (n.includes(t) || h.includes(t)) return 3;
  return wallet.toLowerCase().startsWith(t) ? 4 : 5;
}

export async function searchAsyl(q: string, tracked: readonly TrackedWallet[]): Promise<SearchRead> {
  const text = q.trim();
  const handle = text.replace(/^@/, "");
  const [tokenRows, kols] = await Promise.all([
    prisma.token.findMany({
      where: { AND: [tokenTextWhere(text), TRACKED] },
      select: {
        mintAddress: true,
        symbol: true,
        name: true,
        imageUrl: true,
        liveMarketCapUsd: true,
        launchedAt: true,
        firstSeenAt: true,
      },
      orderBy: { firstSeenAt: "desc" },
      take: SEARCH_TOKENS_READ,
    }),
    prisma.kolWallet.findMany({
      where: {
        OR: [
          { name: { contains: handle, mode: "insensitive" } },
          { twitter: { contains: handle, mode: "insensitive" } },
          { wallet: { startsWith: text } },
        ],
      },
      select: { wallet: true, name: true, twitter: true, winRate: true, realizedPnlUsd: true },
      orderBy: { realizedPnlUsd: { sort: "desc", nulls: "last" } },
      take: 40,
    }),
  ]);
  const tokens = tokenRows
    .map((r) => ({ r, rank: matchRank(text, r.symbol, r.name, r.mintAddress) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SEARCH_TOKENS_SHOWN)
    .map(({ r }): SearchToken => ({
      mint: r.mintAddress,
      symbol: r.symbol,
      name: r.name,
      image: r.imageUrl,
      mcapUsd: r.liveMarketCapUsd,
      launchedAt: (r.launchedAt ?? r.firstSeenAt).toISOString(),
    }));

  const lower = handle.toLowerCase();
  const labels: SearchWallet[] = tracked
    .filter((t) => t.name.toLowerCase().includes(lower) || t.wallet.startsWith(text))
    .map((t) => ({
      wallet: t.wallet,
      name: t.name,
      kind: t.category === "kol" ? "kol" : "label",
      twitter: null,
      avatar: null,
      winRate: null,
      pnlUsd: null,
    }));
  const labelled = new Set(labels.map((l) => l.wallet));
  const roster: SearchWallet[] = kols
    .filter((k) => !labelled.has(k.wallet))
    .map((k) => ({
      wallet: k.wallet,
      name: k.name ?? (k.twitter ? `@${k.twitter}` : k.wallet.slice(0, 6)),
      kind: "kol",
      twitter: k.twitter,
      avatar: null,
      winRate: k.winRate,
      pnlUsd: k.realizedPnlUsd,
    }));
  const wallets = [...labels, ...roster]
    .map((w, i) => ({ w, i, rank: walletRank(text, w.name, w.twitter, w.wallet) }))
    // Best match first; the reader's own labels, then the roster by PnL, among equals.
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, SEARCH_WALLETS_SHOWN)
    .map(({ w }) => w);
  if (wallets.length) {
    // Their X pictures, as the map's bubbles show them; a search without them is still an answer.
    const names = await loadWalletNames(
      wallets.map((w) => w.wallet),
      null,
    )
      .then((r) => r.names)
      .catch(() => ({}) as Record<string, { avatar?: string }>);
    for (const w of wallets) w.avatar = names[w.wallet]?.avatar ?? null;
  }
  return { q: text, tokens, wallets };
}
