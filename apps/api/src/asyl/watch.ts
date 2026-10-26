import { prisma } from "@trenchscanner/core";

/**
 * Asyl watchlists (user ask 2026-10-26, "watchlists and alerts"): wallets a user follows, and what
 * each did since they last looked, read from TrenchScanner's own tables when the list opens: a
 * wallet it funded, a coin it bought, a coin it deployed. Database only, so free of credits, and no
 * job runs for it. Private to the user.
 */

/** Wallets one user watches at most. */
export const WATCH_MAX = 50;
/** Events listed per wallet, newest first. */
export const WATCH_EVENTS = 12;
/** How far back a fresh watch, or one not opened in a long while, looks. */
export const WATCH_LOOKBACK_MS = 7 * 24 * 3_600_000;
/** Rows each lookup takes for the whole list. */
const ROWS = 600;

export interface WatchEvent {
  kind: "funded" | "bought" | "deployed";
  /** The wallet it funded, or the coin it bought or deployed. */
  target: string;
  /** A coin's ticker, when known. */
  symbol: string | null;
  sol: number | null;
  at: string;
}

export interface WatchRow {
  wallet: string;
  name: string | null;
  seenAt: string;
  /** Events since a week before `seenAt`, newest first; `fresh` counts those after it. */
  events: WatchEvent[];
  fresh: number;
}

export async function listWatches(userId: string, now = Date.now()): Promise<WatchRow[]> {
  const rows = await prisma.asylWatch.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { wallet: true, name: true, seenAt: true },
  });
  if (rows.length === 0) return [];
  const wallets = rows.map((r) => r.wallet);
  // Back to the earliest a row looks: a week before its seenAt, or a week back for a new one.
  const since = new Date(
    Math.min(now - WATCH_LOOKBACK_MS, ...rows.map((r) => r.seenAt.getTime() - WATCH_LOOKBACK_MS)),
  );
  const [funded, bought, deployed] = await Promise.all([
    prisma.walletFunder.findMany({
      where: { funder: { in: wallets }, status: "found", fundedAt: { gt: since } },
      orderBy: { fundedAt: "desc" },
      take: ROWS,
      select: { funder: true, wallet: true, amountSol: true, fundedAt: true },
    }),
    prisma.tokenWalletActivity.findMany({
      where: { wallet: { in: wallets }, firstBuyAt: { gt: since } },
      orderBy: { firstBuyAt: "desc" },
      take: ROWS,
      select: {
        wallet: true,
        solIn: true,
        firstBuyAt: true,
        isCreator: true,
        token: { select: { mintAddress: true, symbol: true } },
      },
    }),
    prisma.token.findMany({
      where: {
        OR: [{ deployer: { in: wallets } }, { deployer: null, creator: { in: wallets } }],
        firstSeenAt: { gt: since },
      },
      orderBy: { firstSeenAt: "desc" },
      take: ROWS,
      select: {
        mintAddress: true,
        symbol: true,
        deployer: true,
        creator: true,
        launchedAt: true,
        firstSeenAt: true,
      },
    }),
  ]);
  const byWallet = new Map<string, WatchEvent[]>(wallets.map((w) => [w, []]));
  for (const f of funded)
    byWallet.get(f.funder!)?.push({
      kind: "funded",
      target: f.wallet,
      symbol: null,
      sol: f.amountSol,
      at: f.fundedAt!.toISOString(),
    });
  for (const b of bought) {
    // Its own launch shows as a deploy, not a buy.
    if (b.isCreator) continue;
    byWallet.get(b.wallet)?.push({
      kind: "bought",
      target: b.token.mintAddress,
      symbol: b.token.symbol,
      sol: b.solIn,
      at: b.firstBuyAt!.toISOString(),
    });
  }
  for (const t of deployed)
    byWallet.get((t.deployer ?? t.creator)!)?.push({
      kind: "deployed",
      target: t.mintAddress,
      symbol: t.symbol,
      sol: null,
      at: (t.launchedAt ?? t.firstSeenAt).toISOString(),
    });
  return rows.map((r) => {
    const all = (byWallet.get(r.wallet) ?? [])
      .filter((e) => Date.parse(e.at) > r.seenAt.getTime() - WATCH_LOOKBACK_MS)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return {
      wallet: r.wallet,
      name: r.name,
      seenAt: r.seenAt.toISOString(),
      events: all.slice(0, WATCH_EVENTS),
      fresh: all.filter((e) => Date.parse(e.at) > r.seenAt.getTime()).length,
    };
  });
}

export type WatchAdd = { ok: true } | { ok: false; reason: "full" };

/** Starts watching a wallet, or renames one already watched. A new watch counts from a week back. */
export async function addWatch(
  userId: string,
  wallet: string,
  name: string | null,
  now = Date.now(),
): Promise<WatchAdd> {
  const have = await prisma.asylWatch.findUnique({ where: { userId_wallet: { userId, wallet } } });
  if (have) {
    await prisma.asylWatch.update({ where: { userId_wallet: { userId, wallet } }, data: { name } });
    return { ok: true };
  }
  if ((await prisma.asylWatch.count({ where: { userId } })) >= WATCH_MAX)
    return { ok: false, reason: "full" };
  await prisma.asylWatch.create({ data: { userId, wallet, name, seenAt: new Date(now) } });
  return { ok: true };
}

export async function removeWatch(userId: string, wallet: string): Promise<boolean> {
  const r = await prisma.asylWatch.deleteMany({ where: { userId, wallet } });
  return r.count > 0;
}

/** Marks what one wallet, or every watched wallet, has done as seen. */
export async function markSeen(userId: string, wallet: string | null, now = Date.now()): Promise<void> {
  await prisma.asylWatch.updateMany({
    where: { userId, ...(wallet ? { wallet } : {}) },
    data: { seenAt: new Date(now) },
  });
}
