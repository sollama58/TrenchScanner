import type { FastifyInstance } from "fastify";
import {
  adminWalletSet,
  creditBalance,
  enabledContestants,
  prisma,
  resolveAccess,
  TradingRpc,
  withApiFeature,
  type Env,
  walletTag,
  type WalletBalance,
} from "@trenchscanner/core";
import { proStatus } from "../proMode.js";
import { SolPrice } from "../solPrice.js";
import { tokenView, type UtilityTokenView } from "./utilities.js";

/**
 * The Portfolio tab (user ask 2026-10-18), for Pro Mode wallets only (user decision 2026-10-18):
 * anyone else gets a 404, and nothing is read for them. What TrenchScanner knows about the
 * signed-in wallet, for its owner alone - every read is keyed on the session's own wallet, nothing takes an address
 * from the request, and the answer is never cached outside the owner's browser.
 *
 *   GET /portfolio   the account, the coins it holds that TrenchScanner tracks, its bot's open
 *                    positions, its trades in tracked coins, and its alerts
 *
 * Pro Mode trades are read from GET /pro/trades?view=portfolio (routes/proTrades.ts).
 *
 * Tracked coins only: a coin is listed when the scanner tracks it on its own (lookupGate.ts
 * mintOnFeed's rule: on Token, and not only because someone looked it up), so nothing here gives
 * away a paid lookup. The rest of the wallet's coins are counted, never named.
 *
 * Credits (Helius): the holdings are the only chain read - getBalance and two
 * getTokenAccountsByOwner, a credit each - and one reading is reused for HOLDINGS_TTL_MS per wallet.
 * Prices come from the scanner's own rows; nothing else is asked of anyone.
 */

const HOLDINGS_TTL_MS = 5 * 60_000;
/** Held coins listed (by value), each with a card that opens the token modal. */
const HOLDINGS_SHOWN = 30;
/** Held coins worth less than this many SOL are dust: left out of the list and the totals (user ask 2026-10-18). */
const HOLDINGS_MIN_SOL = 0.01;
/** Mints matched against Token from one wallet: a wallet full of dust can't make the read huge. */
const HOLDINGS_MINTS_MAX = 500;
/** Tracked coins valued from one wallet (two reads each). */
const HOLDINGS_TRACKED_MAX = 100;
const TAPE_COINS = 20;
const BOT_POSITIONS = 50;
const LAMPORTS_PER_SOL = 1e9;

export interface PortfolioHolding {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  marketCapUsd: number | null;
  /** When the price was read (a live tick or the newest scan). */
  pricedAt: Date | null;
  /** The first model alert on the coin, if any. */
  firstAlert: { at: Date; modelName: string | null } | null;
  card: UtilityTokenView["card"] | null;
}

type Reading = { at: number; lamports: bigint | null; balances: WalletBalance[] | null };

export async function registerPortfolioRoutes(app: FastifyInstance, opts: { env: Env }) {
  const { env } = opts;
  const admins = adminWalletSet(env);
  const models = new Map(enabledContestants(env.CURATOR_CONTESTANTS).map((c) => [c.id, c.name]));
  const canRead = !!(env.HELIUS_API_KEY || env.SOLANA_RPC_URL);
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const solPrice = new SolPrice();
  const readings = new Map<string, Reading>();
  const reading = new Map<string, Promise<Reading>>();

  /** The wallet's SOL and coins, read at most every HOLDINGS_TTL_MS (in flight once per wallet). */
  async function walletReading(wallet: string): Promise<Reading | null> {
    if (!canRead) return null;
    const kept = readings.get(wallet);
    if (kept && Date.now() - kept.at < HOLDINGS_TTL_MS) return kept;
    let pending = reading.get(wallet);
    if (!pending) {
      pending = withApiFeature("portfolio", async () => {
        const [lamports, balances] = await Promise.all([
          rpc.getBalance(wallet),
          rpc.getWalletBalances(wallet),
        ]);
        return { at: Date.now(), lamports, balances };
      })
        .then((r) => {
          // A failed read isn't kept: the next look asks again.
          if (r.balances !== null) {
            readings.set(wallet, r);
            if (readings.size > 5_000) readings.delete(readings.keys().next().value!);
          }
          return r;
        })
        .catch((err) => {
          app.log.warn({ wallet: walletTag(wallet), err: String(err) }, "portfolio: wallet read failed");
          return { at: Date.now(), lamports: null, balances: null };
        })
        .finally(() => reading.delete(wallet));
      reading.set(wallet, pending);
    }
    return pending;
  }

  // Like the rest of the dashboard, behind the paywall: the holdings carry tracked coins' cards.
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/", async (request, reply) => {
    const { walletAddress: wallet, userId } = request.user!;
    reply.header("Cache-Control", "private, no-store");
    const pro = await proStatus(env, wallet);
    if (!pro.pro) return reply.code(404).send({ error: "not found" });
    const since7 = new Date(Date.now() - 7 * 86_400_000);
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [
      user,
      access,
      credits,
      lookups30d,
      burns,
      filters,
      alerts,
      chats,
      devices,
      risk,
      bot,
      tape,
      held,
      sol,
    ] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { createdAt: true, feedModels: true, followBestModel: true, showModelAlerts: true },
      }),
      request.access ?? resolveAccess(wallet, admins),
      creditBalance(wallet),
      prisma.burnCreditEntry.count({ where: { wallet, kind: "spend", createdAt: { gt: since30 } } }),
      prisma.burnEvent.aggregate({
        where: { burnerWallet: wallet },
        _count: { _all: true },
        _sum: { monthsCredited: true },
      }),
      prisma.userFilter.groupBy({
        by: ["isActive"],
        where: { userId, deletedAt: null },
        _count: { _all: true },
      }),
      alertSummary(userId, since7, since30),
      prisma.telegramChat.count({ where: { userId } }),
      prisma.linkedDevice.count({ where: { userId, revokedAt: null } }),
      prisma.walletRisk.findUnique({
        where: { wallet },
        select: { score: true, appearances: true, wins: true, dumper: true, winner: true, sniper: true },
      }),
      prisma.tradingPosition.findMany({
        where: { userId, status: { in: ["buying", "open", "stuck"] } },
        orderBy: { createdAt: "desc" },
        take: BOT_POSITIONS,
        select: {
          id: true,
          mint: true,
          symbol: true,
          status: true,
          sourceLabel: true,
          swapInLamports: true,
          proceedsLamports: true,
          lastMultiple: true,
          highMultiple: true,
          lastPricedAt: true,
          openedAt: true,
        },
      }),
      tapeActivity(wallet),
      walletReading(wallet),
      solPrice.get(),
    ]);

    const active = filters.find((f) => f.isActive)?._count._all ?? 0;
    const inactive = filters.find((f) => !f.isActive)?._count._all ?? 0;
    const followed = user.followBestModel
      ? null
      : user.feedModels.map((id) => ({ id, name: models.get(id) ?? id }));

    return {
      account: {
        // The owner's own address, to the owner only: the tab shows it shortened with a copy button.
        walletAddress: wallet,
        memberSince: user.createdAt,
        admin: access.reason === "admin",
        access: { hasAccess: access.hasAccess, reason: access.reason, expiresAt: access.expiresAt },
        // Pro Mode is shown to no one without it (user decision 2026-10-17): no source, no rank.
        pro: pro.pro
          ? { source: pro.source, rank: pro.rank ?? null, graceEndsAt: pro.graceEndsAt ?? null }
          : null,
        burnCredits: credits,
        lookups30d,
        burns: { count: burns._count._all, months: burns._sum.monthsCredited ?? 0 },
        telegramChats: chats,
        linkedDevices: devices,
      },
      holdings: held ? await holdingsView(held, sol) : null,
      botPositions: bot.map((p) => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        status: p.status,
        source: p.sourceLabel,
        spentSol: p.swapInLamports !== null ? Number(p.swapInLamports) / LAMPORTS_PER_SOL : null,
        gotSol: Number(p.proceedsLamports) / LAMPORTS_PER_SOL,
        lastMultiple: p.lastMultiple,
        highMultiple: p.highMultiple,
        lastPricedAt: p.lastPricedAt,
        openedAt: p.openedAt,
      })),
      tape: { ...tape, risk },
      alerts: {
        ...alerts,
        filtersActive: active,
        filtersOff: inactive,
        modelAlertsOn: user.showModelAlerts,
        followsBestModel: user.followBestModel,
        followedModels: followed,
      },
      solUsd: sol ?? null,
    };
  });

  /** The coins held that the scanner tracks, valued from its own prices, and a count of the rest. */
  async function holdingsView(r: Reading, sol: number | null) {
    const balances = r.balances ?? [];
    const mints = balances.slice(0, HOLDINGS_MINTS_MAX).map((b) => b.mint);
    const tokens = mints.length
      ? await prisma.token.findMany({
          where: { mintAddress: { in: mints } },
          select: {
            id: true,
            mintAddress: true,
            symbol: true,
            name: true,
            imageUrl: true,
            discoverySource: true,
            livePriceUsd: true,
            liveMarketCapUsd: true,
            liveDataAt: true,
          },
        })
      : [];
    // A coin only looked up counts as tracked once a model or a filter alerted on it (mintOnFeed).
    const lookedUp = tokens.filter((t) => t.discoverySource === "utility").map((t) => t.id);
    const [lookedUpCalls, lookedUpMatches] = lookedUp.length
      ? await Promise.all([
          prisma.curatedAlert.groupBy({ by: ["tokenId"], where: { tokenId: { in: lookedUp } } }),
          prisma.match.groupBy({ by: ["tokenId"], where: { tokenId: { in: lookedUp } } }),
        ])
      : [[], []];
    const alerted = new Set([...lookedUpCalls, ...lookedUpMatches].map((x) => x.tokenId));
    const trackedAll = tokens.filter((t) => t.discoverySource !== "utility" || alerted.has(t.id));
    const tracked = trackedAll.slice(0, HOLDINGS_TRACKED_MAX);
    // The newest scan and the first model alert of each, one indexed read apiece.
    const [snaps, firstCalls] = await Promise.all([
      Promise.all(
        tracked.map((t) =>
          prisma.tokenSnapshot.findFirst({
            where: { tokenId: t.id },
            orderBy: { takenAt: "desc" },
            select: { takenAt: true, priceUsd: true, marketCapUsd: true },
          }),
        ),
      ),
      Promise.all(
        tracked.map((t) =>
          prisma.curatedAlert.findFirst({
            where: { tokenId: t.id },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true, modelName: true },
          }),
        ),
      ),
    ]);
    const snapOf = new Map(tracked.map((t, i) => [t.id, snaps[i]]));
    const callOf = new Map(tracked.map((t, i) => [t.id, firstCalls[i]]));
    const balanceOf = new Map(balances.map((b) => [b.mint, b]));

    const rows = tracked.map((t) => {
      const b = balanceOf.get(t.mintAddress)!;
      const amount = Number(b.raw) / 10 ** b.decimals;
      const snap = snapOf.get(t.id);
      // The newer of the live tick and the newest scan.
      const live = t.livePriceUsd && t.liveDataAt ? { at: t.liveDataAt, price: t.livePriceUsd } : null;
      const scanned = snap?.priceUsd ? { at: snap.takenAt, price: snap.priceUsd } : null;
      const pick = live && (!scanned || live.at >= scanned.at) ? live : scanned;
      const mcap = pick === live ? (t.liveMarketCapUsd ?? null) : (snap?.marketCapUsd ?? null);
      const call = callOf.get(t.id);
      return {
        mint: t.mintAddress,
        symbol: t.symbol,
        name: t.name,
        imageUrl: t.imageUrl,
        amount,
        priceUsd: pick?.price ?? null,
        valueUsd: pick ? pick.price * amount : null,
        marketCapUsd: mcap,
        pricedAt: pick?.at ?? null,
        firstAlert: call ? { at: call.createdAt, modelName: call.modelName } : null,
        card: null as PortfolioHolding["card"],
      };
    });
    // Unpriced coins can't be shown to clear the minimum, so they count as dust too. Without a SOL
    // price the minimum can't be applied, so only unpriced coins are dropped.
    const minUsd = sol ? HOLDINGS_MIN_SOL * sol : 0;
    const kept = rows.filter((h) => h.valueUsd !== null && h.valueUsd >= minUsd);
    kept.sort((a, b) => b.valueUsd! - a.valueUsd!);
    const shown = kept.slice(0, HOLDINGS_SHOWN);
    const views = await Promise.all(shown.map((h) => tokenView(h.mint, new Date())));
    shown.forEach((h, i) => (h.card = views[i]?.card ?? null));
    const solHeld = r.lamports !== null ? Number(r.lamports) / LAMPORTS_PER_SOL : null;
    const trackedUsd = kept.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    return {
      readAt: new Date(r.at),
      sol: solHeld,
      solValueUsd: solHeld !== null && sol ? solHeld * sol : null,
      coins: shown satisfies PortfolioHolding[],
      /** Tracked coins worth at least HOLDINGS_MIN_SOL (past HOLDINGS_TRACKED_MAX, unvalued ones count too). */
      trackedCoins: kept.length + (trackedAll.length - tracked.length),
      trackedValueUsd: trackedUsd,
      /** Tracked coins held below HOLDINGS_MIN_SOL, or with no price: counted, not shown. */
      dust: rows.length - kept.length,
      minSol: HOLDINGS_MIN_SOL,
      /** Coins in the wallet the scanner doesn't track: counted, not shown. */
      untracked: balances.length - trackedAll.length,
    };
  }
}

/** The owner's filter alerts over 7 and 30 days: how many, how many reached 2x, and the best one. */
async function alertSummary(userId: string, since7: Date, since30: Date) {
  const [count7, count30, doubled30, best] = await Promise.all([
    prisma.match.count({ where: { userId, matchedAt: { gt: since7 } } }),
    prisma.match.count({ where: { userId, matchedAt: { gt: since30 } } }),
    prisma.match.count({ where: { userId, matchedAt: { gt: since30 }, hitHundredPctAt: { not: null } } }),
    prisma.match.findFirst({
      where: { userId, matchedAt: { gt: since30 }, peakReturnPct: { not: null } },
      orderBy: { peakReturnPct: "desc" },
      select: {
        matchedAt: true,
        peakReturnPct: true,
        token: { select: { mintAddress: true, symbol: true, imageUrl: true } },
      },
    }),
  ]);
  return {
    last7d: count7,
    last30d: count30,
    doubled30d: doubled30,
    best30d: best
      ? {
          at: best.matchedAt,
          peakReturnPct: best.peakReturnPct,
          mint: best.token.mintAddress,
          symbol: best.token.symbol,
          imageUrl: best.token.imageUrl,
        }
      : null,
  };
}

/**
 * The wallet's trades in tracked coins, as the scanner's trade tape recorded them
 * (TokenWalletActivity): every tracked coin whose tape was read and the wallet traded in. SOL
 * figures are the tape's; coins still held are not valued here (the holdings are).
 */
async function tapeActivity(wallet: string) {
  const [totals, recent] = await Promise.all([
    prisma.tokenWalletActivity.aggregate({
      where: { wallet },
      _count: { _all: true },
      _sum: { buys: true, sells: true, solIn: true, solOut: true },
    }),
    prisma.tokenWalletActivity.findMany({
      where: { wallet },
      orderBy: { createdAt: "desc" },
      take: TAPE_COINS,
      select: {
        buys: true,
        sells: true,
        solIn: true,
        solOut: true,
        firstBuyAt: true,
        createdAt: true,
        isCreator: true,
        launchSniper: true,
        token: { select: { mintAddress: true, symbol: true, name: true, imageUrl: true } },
      },
    }),
  ]);
  return {
    coins: totals._count._all,
    buys: totals._sum.buys ?? 0,
    sells: totals._sum.sells ?? 0,
    solIn: totals._sum.solIn ?? 0,
    solOut: totals._sum.solOut ?? 0,
    recent: recent.map((r) => ({
      mint: r.token.mintAddress,
      symbol: r.token.symbol,
      name: r.token.name,
      imageUrl: r.token.imageUrl,
      buys: r.buys,
      sells: r.sells,
      solIn: r.solIn,
      solOut: r.solOut,
      firstBuyAt: r.firstBuyAt,
      readAt: r.createdAt,
      creator: r.isCreator,
      sniper: r.launchSniper,
    })),
  };
}
