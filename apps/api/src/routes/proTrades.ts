import type { FastifyInstance } from "fastify";
import {
  HeliusAccountStream,
  JupiterSwapClient,
  mintSupplies,
  prisma,
  TradingRpc,
  withApiFeature,
  type DexScreenerClient,
  type Env,
} from "@trenchscanner/core";
import { isProWallet } from "../proMode.js";
import {
  LazyTradeStream,
  positionPnl,
  positionsOf,
  ProTradeWatcher,
  tradesOf,
  tradeStats,
  type Position,
  type TradeStats,
  liveUsdPrices,
} from "../proTrades.js";
import { sharedSolPrice } from "../solPrice.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import {
  keepReading,
  tokenView,
  upsertLookedUpToken,
  UTILITY_TOKEN_LOOKUP,
  type UtilityTokenView,
} from "./utilities.js";

/**
 * The TRADES panel (user ask 2026-10-18), for Pro Mode wallets only; anyone else gets a 404.
 *
 *   GET /pro/trades          the wallet's last coins traded (cards), and its trade statistics
 *   GET /pro/trades?brief=1  the last three coins' pictures, for the panel's closed handle
 *   GET /pro/trades?view=portfolio  the Portfolio tab's trades: open positions, closed ones, and
 *                            the statistics over a day, a week and 30 days
 *
 * Every call keeps the wallet followed on the Helius stream and, when due, catches up on what it
 * traded while it wasn't (proTrades.ts says what that costs). Each coin the wallet buys from a
 * flat position is scanned like a Utilities lookup - on Token, stamped as viewed so the worker
 * scans it (holders, bubble map), and asked of TokenSage - without a Burn Credit: the trade is the
 * lookup. The coin's token modal opens for its trader from then on (lookupGate.ts).
 */

/** The coins the panel lists, and the ones its handle shows. */
const PANEL_COINS = 10;
const HANDLE_COINS = 3;
/** The statistics' window, and how far back trades are read for them. */
const STATS_HOURS = 24;
const ROWS_MAX = 2_000;
/** An answer is reused this long per wallet and shape (the panel polls; the stream fills in between). */
const ANSWER_TTL_MS = 8_000;
/** How long the first look waits on a due catch-up before answering with what is recorded. */
const CATCH_UP_WAIT_MS = 2_500;
/** A held coin's live price (Jupiter, DexScreener behind it) is reused this long. */
const LIVE_PRICE_TTL_MS = 15_000;
/** How long the cards wait on the live prices before answering with the stored ones. */
const LIVE_PRICE_WAIT_MS = 2_500;
/** A coin whose market data is this fresh needs no lookup for its scan: only the view stamp. */
const FRESH_MARKET_MS = 2 * 60_000;
/** Open coins are stamped as viewed (kept on the scan) only while the panel is open, at most this often. */
const STAMP_EVERY_MS = 5 * 60_000;
/** The Portfolio tab's lists, and the days of trades it covers (all readRows keeps). */
const PORTFOLIO_OPEN_COINS = 40;
const PORTFOLIO_CLOSED_COINS = 20;
const PORTFOLIO_DAYS = 30;

export interface TradeCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  entryAt: Date;
  lastTradeAt: Date;
  buys: number;
  sells: number;
  spentSol: number;
  gotSol: number;
  held: number;
  closed: boolean;
  /** Market cap at the scan nearest the entry; null before the first scan. */
  entryMcapUsd: number | null;
  /** The result so far in SOL (open coins at today's price); null when it can't be priced. */
  pnlSol: number | null;
  pnlPct: number | null;
  /** TrenchScanner's call on the coin before the entry, if it made one. */
  calledBefore: { at: Date; modelName: string | null; confidence: number } | null;
  /** The feed card the token modal opens on; null for a coin not on Token yet (no scan). */
  card: UtilityTokenView["card"] | null;
  scan: "scanning" | "scanned" | "none";
}

export async function registerProTradesRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    dexScreener: DexScreenerClient;
    viewStamps: ViewStampBuffer;
    /** Coins' live USD prices; the default asks Jupiter, then DexScreener for what it can't price. */
    livePricesUsd?: (mints: string[]) => Promise<Map<string, number>>;
  },
) {
  const { env } = opts;
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const solPrice = sharedSolPrice;
  const canRead = !!(env.HELIUS_API_KEY || env.SOLANA_RPC_URL);
  const jupiter = new JupiterSwapClient({
    apiKey: env.PRO_TRADING_JUPITER_API_KEY || undefined,
    backupApiKey: env.JUPITER_API_KEY || undefined,
  });
  const askLivePrices = opts.livePricesUsd ?? ((mints: string[]) => jupiter.pricesUsd(mints));
  /**
   * The held coins' prices now (user report 2026-10-19: the cards' Now and PnL were off). The
   * stored price is a scan's or the last viewer's tick, which can be hours old for a coin nobody
   * else watches; a held coin's card is priced from a live read instead, like the token page.
   * Empty when nothing could be read in time (the stored prices stand in), and off in tests.
   */
  const livePricesFor = liveUsdPrices(askLivePrices, {
    enabled: canRead || !!opts.livePricesUsd,
    ttlMs: LIVE_PRICE_TTL_MS,
    waitMs: LIVE_PRICE_WAIT_MS,
  });

  /** The coin's scan, once per entry: a Utilities lookup without the credit. */
  async function scanEntry(_wallet: string, mint: string): Promise<void> {
    const now = new Date();
    const token = await prisma.token.findUnique({
      where: { mintAddress: mint },
      select: { id: true, liveDataAt: true },
    });
    if (token?.liveDataAt && now.getTime() - token.liveDataAt.getTime() < FRESH_MARKET_MS) {
      await prisma.token.update({ where: { id: token.id }, data: { lastViewedAt: now } });
      return;
    }
    const failed = new Set<string>();
    const [reading] = await withApiFeature("pro-trades", () =>
      opts.dexScreener.getTokensByAddresses([mint], 1, UTILITY_TOKEN_LOOKUP(mint, failed)),
    );
    if (reading && reading.marketCapUsd > 0) {
      keepReading(mint, reading, now);
      await upsertLookedUpToken(mint, reading, now);
    } else if (token) {
      await prisma.token.update({ where: { id: token.id }, data: { lastViewedAt: now } });
    }
  }

  // The stream is made on the first watch, by which time `watcher` exists.
  const apiKey = env.HELIUS_API_KEY;
  const stream =
    env.PRO_TRADING_ENABLED && apiKey && (globalThis as { WebSocket?: unknown }).WebSocket
      ? new LazyTradeStream(() =>
          new HeliusAccountStream(HeliusAccountStream.urlFor(apiKey), (key, signature, tx) =>
            watcher.onStreamTx(key, signature, tx),
          ).metered("stream/pro-trades"),
        )
      : null;
  const watcher: ProTradeWatcher = new ProTradeWatcher({ stream, rpc, onEntry: scanEntry });
  if (stream) app.addHook("onClose", async () => stream.stop());

  const answers = new Map<string, { at: number; body: unknown }>();
  const stamped = new Map<string, number>();

  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request, reply) => {
    const wallet = request.user!.walletAddress;
    if (!(await isProWallet(env, wallet))) return reply.code(404).send({ error: "not found" });
    const query = request.query as { brief?: string; open?: string; view?: string };
    const brief = query.brief === "1";
    const portfolio = !brief && query.view === "portfolio";
    // Without a node of our own (tests, a local run) nothing is read: the public RPC would be asked.
    const due = canRead ? watcher.touch(wallet) : Promise.resolve();
    const open = query.open === "1";
    // An open panel's read stamps its coins (fullView). Under the closed panel's key, a poll with
    // the panel open could be answered from that cache and skip the stamps.
    const key = `${wallet}:${brief ? "brief" : portfolio ? "portfolio" : open ? "full-open" : "full"}`;
    const cached = answers.get(key);
    reply.header("Cache-Control", "no-store");
    if (cached && Date.now() - cached.at < ANSWER_TTL_MS) return cached.body;
    await Promise.race([due, new Promise((r) => setTimeout(r, CATCH_UP_WAIT_MS))]);
    const body = brief
      ? await handleView(wallet)
      : portfolio
        ? await portfolioView(wallet)
        : await fullView(wallet, open);
    answers.set(key, { at: Date.now(), body });
    if (answers.size > 2_000) answers.delete(answers.keys().next().value!);
    return body;
  });

  async function readRows(wallet: string) {
    return prisma.proTrade.findMany({
      where: { wallet, at: { gt: new Date(Date.now() - 30 * 86_400_000) } },
      orderBy: { at: "desc" },
      take: ROWS_MAX,
      select: {
        signature: true,
        mint: true,
        side: true,
        lamports: true,
        tokens: true,
        decimals: true,
        at: true,
        entry: true,
      },
    });
  }

  /** The handle's three pictures: the newest coins entered. */
  async function handleView(wallet: string) {
    const positions = positionsOf(await readRows(wallet)).slice(0, HANDLE_COINS);
    const tokens = await prisma.token.findMany({
      where: { mintAddress: { in: positions.map((p) => p.mint) } },
      select: { mintAddress: true, symbol: true, imageUrl: true },
    });
    const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
    return {
      coins: positions.map((p) => ({
        mint: p.mint,
        symbol: byMint.get(p.mint)?.symbol ?? null,
        imageUrl: byMint.get(p.mint)?.imageUrl ?? null,
        closed: p.closed,
        entryAt: p.entryAt,
      })),
    };
  }

  async function fullView(wallet: string, panelOpen: boolean) {
    const rows = await readRows(wallet);
    const positions = positionsOf(rows);
    const shown = positions.slice(0, PANEL_COINS);
    const since = new Date(Date.now() - STATS_HOURS * 3_600_000);
    const windowRows = rows.filter((r) => r.at > since);
    // Every trade that ran in the window, a coin's earlier round trips included.
    const windowPositions = tradesOf(rows).filter((p) => p.entryAt > since || p.lastTradeAt > since);
    const built = await coinsFor(
      shown,
      windowRows.filter((r) => r.entry).map((r) => r.mint),
    );

    // While the panel is open, its open coins stay on the scan (their Now and PnL move with it).
    if (panelOpen) {
      const now = Date.now();
      const ids = shown.flatMap((p) => {
        const t = built.tokenByMint.get(p.mint);
        if (!t || p.closed) return [];
        const k = `${wallet}:${t.id}`;
        if (now - (stamped.get(k) ?? 0) < STAMP_EVERY_MS) return [];
        stamped.set(k, now);
        return [t.id];
      });
      if (stamped.size > 10_000) stamped.clear();
      if (ids.length > 0) opts.viewStamps.record(ids);
    }

    const stats: TradeStats = tradeStats(
      windowRows,
      windowPositions,
      built.priceSol,
      (mint, at) => built.callBefore(mint, at) !== null,
      STATS_HOURS,
    );
    return { coins: built.coins, stats, solUsd: built.sol, solUsdAt: built.solAt, following: true };
  }

  /**
   * The Portfolio tab's trades (user ask 2026-10-18): every open position, the latest closed ones,
   * and the statistics over a day, a week and the 30 days of trades kept. Only coins on Token are
   * listed - each one the wallet bought was put through a scan on the entry, so a coin missing
   * here had no market to scan - and `untracked` counts the rest.
   */
  async function portfolioView(wallet: string) {
    const rows = await readRows(wallet);
    const positions = positionsOf(rows);
    const onToken = new Set(
      (
        await prisma.token.findMany({
          where: { mintAddress: { in: [...new Set(positions.map((p) => p.mint))] } },
          select: { mintAddress: true },
        })
      ).map((t) => t.mintAddress),
    );
    const listed = positions.filter((p) => onToken.has(p.mint));
    const open = listed.filter((p) => !p.closed).slice(0, PORTFOLIO_OPEN_COINS);
    const closed = listed.filter((p) => p.closed).slice(0, PORTFOLIO_CLOSED_COINS);
    const built = await coinsFor([...open, ...closed], []);
    const trades = tradesOf(rows).filter((p) => onToken.has(p.mint));
    const statsOver = (hours: number) => {
      const since = new Date(Date.now() - hours * 3_600_000);
      return tradeStats(
        rows.filter((r) => r.at > since && onToken.has(r.mint)),
        trades.filter((p) => p.entryAt > since || p.lastTradeAt > since),
        built.priceSol,
        (mint, at) => built.callBefore(mint, at) !== null,
        hours,
      );
    };
    return {
      open: built.coins.slice(0, open.length),
      closed: built.coins.slice(open.length),
      stats: [statsOver(24), statsOver(7 * 24), statsOver(PORTFOLIO_DAYS * 24)],
      untracked: positions.length - listed.length,
      openTotal: listed.filter((p) => !p.closed).length,
      closedTotal: listed.filter((p) => p.closed).length,
      days: PORTFOLIO_DAYS,
      solUsd: built.sol,
      solUsdAt: built.solAt,
    };
  }

  /** The cards for `shown`, priced, with the calls before each entry (also asked for `alsoMints`). */
  async function coinsFor(shown: Position[], alsoMints: string[]) {
    const mints = [...new Set([...shown.map((p) => p.mint), ...alsoMints])];
    const [tokens, sol] = await Promise.all([
      prisma.token.findMany({
        where: { mintAddress: { in: mints } },
        select: {
          id: true,
          mintAddress: true,
          symbol: true,
          name: true,
          imageUrl: true,
          livePriceUsd: true,
          liveMarketCapUsd: true,
          liveDataAt: true,
        },
      }),
      solPrice.get(),
    ]);
    const tokenByMint = new Map(tokens.map((t) => [t.mintAddress, t]));
    const calls = tokens.length
      ? await prisma.curatedAlert.findMany({
          where: {
            tokenId: { in: tokens.map((t) => t.id) },
            createdAt: { gt: new Date(Date.now() - 37 * 86_400_000) },
          },
          orderBy: { createdAt: "asc" },
          select: { tokenId: true, createdAt: true, modelName: true, confidence: true },
        })
      : [];
    const callsByMint = new Map<string, typeof calls>();
    const mintOfId = new Map(tokens.map((t) => [t.id, t.mintAddress]));
    for (const c of calls) {
      const m = mintOfId.get(c.tokenId)!;
      callsByMint.set(m, [...(callsByMint.get(m) ?? []), c]);
    }
    const callBefore = (mint: string, at: Date) => {
      const list = callsByMint.get(mint) ?? [];
      let last: (typeof calls)[number] | null = null;
      for (const c of list) if (c.createdAt <= at) last = c;
      return last;
    };
    // A held coin's price is read live (livePricesFor). Otherwise, and when that read fails, the
    // coin's price in SOL is from its newest stored USD price, scan or live tick, whichever is later:
    // the tick is written only while someone views the coin, so it freezes once nobody does while
    // the scans go on (as portfolio.ts and the feed already compare them).
    const held = shown.filter((p) => !p.closed && tokenByMint.has(p.mint)).map((p) => p.mint);
    const [views, live, supplies] = await Promise.all([
      Promise.all(shown.map((p) => (tokenByMint.has(p.mint) ? tokenView(p.mint, p.entryAt) : null))),
      livePricesFor(held),
      mintSupplies()
        .get(shown.map((p) => p.mint))
        .catch(() => new Map<string, number>()),
    ]);
    // The coin's supply, for turning a price into a market cap: its mint's supply now (after
    // burns, mintSupply.ts), else a scan's market cap over its price, else the live tick's.
    const supplyOf = (i: number): number | null => {
      const read = supplies.get(shown[i]!.mint);
      if (read !== undefined) return read;
      const snap = views[i]?.card.latestSnapshot as { priceUsd?: number; marketCapUsd?: number } | undefined;
      if (snap?.priceUsd && snap.marketCapUsd) return snap.marketCapUsd / snap.priceUsd;
      const t = tokenByMint.get(shown[i]!.mint);
      return t?.livePriceUsd && t.liveMarketCapUsd ? t.liveMarketCapUsd / t.livePriceUsd : null;
    };
    const priceUsd = new Map<string, number>(live);
    shown.forEach((p, i) => {
      const card = views[i]?.card;
      const token = tokenByMint.get(p.mint);
      const live = token?.livePriceUsd && token.livePriceUsd > 0 ? token.livePriceUsd : null;
      const snapRow = card?.latestSnapshot as { priceUsd?: number; takenAt?: Date | string } | undefined;
      const snap = snapRow?.priceUsd && snapRow.priceUsd > 0 ? snapRow.priceUsd : null;
      const liveAt = token?.liveDataAt?.getTime() ?? 0;
      const snapAt = snapRow?.takenAt ? new Date(snapRow.takenAt).getTime() : 0;
      const usd = live !== null && (snap === null || liveAt >= snapAt) ? live : snap;
      if (usd !== null && !priceUsd.has(p.mint)) priceUsd.set(p.mint, usd);
    });
    for (const t of tokens)
      if (!priceUsd.has(t.mintAddress) && t.livePriceUsd) priceUsd.set(t.mintAddress, t.livePriceUsd);
    const priceSol = (mint: string) => {
      const usd = priceUsd.get(mint);
      return usd !== undefined && sol ? usd / sol : null;
    };
    // The market cap the entry filled at: its price per coin times the coin's supply (a scan's
    // market cap over its price), else the scan nearest the entry.
    const entryMcaps = await entryMarketCaps(
      shown.flatMap((p) => {
        const t = tokenByMint.get(p.mint);
        return t ? [{ tokenId: t.id, mint: p.mint, at: p.entryAt }] : [];
      }),
    );
    const readAt = new Date();
    shown.forEach((p, i) => {
      const supply = supplyOf(i);
      if (supply === null || !(supply > 0)) return;
      if (p.entryPriceSol !== null && sol) {
        const mcap = p.entryPriceSol * sol * supply;
        if (Number.isFinite(mcap) && mcap > 0) entryMcaps.set(p.mint, mcap);
      }
      // A held coin's Now is its live price too, so Now, the move and the PnL agree.
      const usd = live.get(p.mint);
      const card = views[i]?.card;
      if (usd !== undefined && card) {
        card.currentMarketCapUsd = usd * supply;
        card.currentMarketCapAt = readAt;
      }
    });

    const coins: TradeCoin[] = shown.map((p: Position, i) => {
      const t = tokenByMint.get(p.mint);
      const pnl = positionPnl(p, priceSol(p.mint));
      const call = callBefore(p.mint, p.entryAt);
      const view = views[i];
      return {
        mint: p.mint,
        symbol: t?.symbol ?? null,
        name: t?.name ?? null,
        imageUrl: t?.imageUrl ?? null,
        entryAt: p.entryAt,
        lastTradeAt: p.lastTradeAt,
        buys: p.buys,
        sells: p.sells,
        spentSol: p.spentSol,
        gotSol: p.gotSol,
        held: p.held,
        closed: p.closed,
        entryMcapUsd: entryMcaps.get(p.mint) ?? null,
        pnlSol: pnl?.sol ?? null,
        pnlPct: pnl?.pct ?? null,
        calledBefore: call
          ? { at: call.createdAt, modelName: call.modelName, confidence: call.confidence }
          : null,
        card: view?.card ?? null,
        scan: view ? view.scan : "none",
      };
    });
    return {
      coins,
      tokenByMint,
      priceSol,
      callBefore,
      sol: sol ?? null,
      solAt: sol ? solPrice.readAt() : null,
    };
  }
}

/**
 * The market cap at the scan nearest each entry, within 15 minutes either side. Two reads per
 * coin on the (tokenId, takenAt) index.
 */
async function entryMarketCaps(
  entries: { tokenId: string; mint: string; at: Date }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    entries.map(async (e) => {
      const [after, before] = await Promise.all([
        prisma.tokenSnapshot.findFirst({
          where: { tokenId: e.tokenId, takenAt: { gte: e.at, lt: new Date(e.at.getTime() + 15 * 60_000) } },
          orderBy: { takenAt: "asc" },
          select: { marketCapUsd: true, takenAt: true },
        }),
        prisma.tokenSnapshot.findFirst({
          where: { tokenId: e.tokenId, takenAt: { lt: e.at, gt: new Date(e.at.getTime() - 15 * 60_000) } },
          orderBy: { takenAt: "desc" },
          select: { marketCapUsd: true, takenAt: true },
        }),
      ]);
      const gap = (x: { takenAt: Date } | null) =>
        x ? Math.abs(x.takenAt.getTime() - e.at.getTime()) : Infinity;
      const mcap = (gap(before) <= gap(after) ? before : after)?.marketCapUsd;
      if (mcap && mcap > 0) out.set(e.mint, mcap);
    }),
  );
  return out;
}
