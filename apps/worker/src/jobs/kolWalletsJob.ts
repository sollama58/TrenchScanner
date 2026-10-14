import {
  KOL_OVERRIDES,
  prisma,
  createLogger,
  type KolEntry,
  type SolanaTrackerClient,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";

const logger = createLogger("kol-wallets");

/**
 * Reads Solana Tracker's KOL roster into KolWallet, once a day. The dashboard labels those
 * wallets as KOLs (the wallet modal, apps/api/src/walletProfile.ts).
 *
 * The roster is paged 100 wallets a request. MAX_PAGES caps one run at a few hundred of the free
 * plan's 10,000 requests a month; the pause between pages keeps under its 3 a second. A wallet
 * that has gone unseen for STALE_AFTER_MS has dropped off the roster and is removed. A run that
 * reads nothing removes nothing, so an outage never empties the table.
 *
 * The hand-named KOLs (KOL_OVERRIDES) are written on every run, roster read or not, with their
 * own name over the roster's, and never go stale. applyKolOverrides also runs ahead of each hourly side-wallet rebuild (index.ts).
 */

const MAX_PAGES = 30;
const PAGE_PAUSE_MS = 500;
const STALE_AFTER_MS = 7 * 86_400_000;

export async function runKolWalletsJob(
  client: Pick<SolanaTrackerClient, "kolPage">,
  opts: { now?: () => number; pauseMs?: number } = {},
): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  const pauseMs = opts.pauseMs ?? PAGE_PAUSE_MS;
  const byWallet = new Map<string, KolEntry>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    if (pages > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const page = await client.kolPage(cursor);
    pages += 1;
    for (const k of page.kols) if (!byWallet.has(k.wallet)) byWallet.set(k.wallet, k);
    cursor = page.nextCursor;
  } while (cursor && pages < MAX_PAGES);

  const kols = [...byWallet.values()];
  if (kols.length === 0) {
    logger.warn("KOL roster read came back empty; keeping the table as it is", { pages });
    const overrides = await applyKolOverrides(now);
    return { pages, kols: 0, removed: 0, overrides };
  }
  await prisma.$transaction(
    kols.map((k) => {
      const override = KOL_OVERRIDES.get(k.wallet);
      const row = {
        name: override?.name ?? k.name,
        twitter: override?.twitter ?? k.twitter,
        realizedPnlUsd: k.realizedPnlUsd,
        winRate: k.winRate,
        lastTradeAt: k.lastTradeAt,
        source: override ? "manual" : "solanatracker",
        seenAt: now,
      };
      return prisma.kolWallet.upsert({
        where: { wallet: k.wallet },
        create: { wallet: k.wallet, ...row },
        update: row,
      });
    }),
  );
  const removed = await prisma.kolWallet.deleteMany({
    where: { seenAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
  });
  const overrides = await applyKolOverrides(now);
  const meta: JobRunMeta = {
    pages,
    kols: kols.length,
    removed: removed.count,
    overrides,
    complete: cursor === null,
  };
  logger.info("KOL roster refreshed", meta);
  return meta;
}

/**
 * Writes the hand-named KOLs (KOL_OVERRIDES) into KolWallet: their name, and their X handle when
 * given, over whatever the roster says. Their roster stats, if any, are left as they are.
 */
export async function applyKolOverrides(now = new Date()): Promise<number> {
  if (KOL_OVERRIDES.size === 0) return 0;
  await prisma.$transaction(
    [...KOL_OVERRIDES].map(([wallet, o]) => {
      const row = {
        name: o.name,
        ...(o.twitter !== undefined ? { twitter: o.twitter } : {}),
        source: "manual",
        seenAt: now,
      };
      return prisma.kolWallet.upsert({ where: { wallet }, create: { wallet, ...row }, update: row });
    }),
  );
  return KOL_OVERRIDES.size;
}
