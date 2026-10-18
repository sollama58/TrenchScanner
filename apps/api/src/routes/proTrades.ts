import type { FastifyInstance } from "fastify";
import {
  HeliusAccountStream,
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
  tradeStats,
  type Position,
  type TradeStats,
} from "../proTrades.js";
import { SolPrice } from "../solPrice.js";
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
const STATS_DAYS = 7;
const ROWS_MAX = 2_000;
/** An answer is reused this long per wallet and shape (the panel polls; the stream fills in between). */
const ANSWER_TTL_MS = 8_000;
/** How long the first look waits on a due catch-up before answering with what is recorded. */
const CATCH_UP_WAIT_MS = 2_500;
/** A coin whose market data is this fresh needs no lookup for its scan: only the view stamp. */
const FRESH_MARKET_MS = 2 * 60_000;
/** Open coins are stamped as viewed (kept on the scan) only while the panel is open, at most this often. */
const STAMP_EVERY_MS = 5 * 60_000;

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
  opts: { env: Env; dexScreener: DexScreenerClient; viewStamps: ViewStampBuffer },
) {
  const { env } = opts;
  const rpc = new TradingRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
    backupUrl: env.TRADING_BACKUP_RPC_URL || undefined,
  });
  const solPrice = new SolPrice();
  const canRead = !!(env.HELIUS_API_KEY || env.SOLANA_RPC_URL);

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
      ? new LazyTradeStream(
          () =>
            new HeliusAccountStream(HeliusAccountStream.urlFor(apiKey), (key, signature, tx) =>
              watcher.onStreamTx(key, signature, tx),
            ),
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
    const query = request.query as { brief?: string; open?: string };
    const brief = query.brief === "1";
    // Without a node of our own (tests, a local run) nothing is read: the public RPC would be asked.
    const due = canRead ? watcher.touch(wallet) : Promise.resolve();
    const key = `${wallet}:${brief ? "brief" : "full"}`;
    const cached = answers.get(key);
    reply.header("Cache-Control", "no-store");
    if (cached && Date.now() - cached.at < ANSWER_TTL_MS) return cached.body;
    await Promise.race([due, new Promise((r) => setTimeout(r, CATCH_UP_WAIT_MS))]);
    const body = brief ? await handleView(wallet) : await fullView(wallet, query.open === "1");
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
    const since = new Date(Date.now() - STATS_DAYS * 86_400_000);
    const windowRows = rows.filter((r) => r.at > since);
    const windowPositions = positions.filter((p) => p.entryAt > since || p.lastTradeAt > since);
    const mints = [
      ...new Set([...shown.map((p) => p.mint), ...windowRows.filter((r) => r.entry).map((r) => r.mint)]),
    ];
    const [tokens, sol] = await Promise.all([
      prisma.token.findMany({
        where: { mintAddress: { in: mints } },
        select: { id: true, mintAddress: true, symbol: true, name: true, imageUrl: true, livePriceUsd: true },
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
    // The coin's price in SOL from its newest USD price (scan or live tick).
    const views = await Promise.all(
      shown.map((p) => (tokenByMint.has(p.mint) ? tokenView(p.mint, p.entryAt) : null)),
    );
    const priceUsd = new Map<string, number>();
    shown.forEach((p, i) => {
      const card = views[i]?.card;
      const live = tokenByMint.get(p.mint)?.livePriceUsd;
      const snap = (card?.latestSnapshot as { priceUsd?: number } | undefined)?.priceUsd;
      const usd = live && live > 0 ? live : snap && snap > 0 ? snap : null;
      if (usd !== null) priceUsd.set(p.mint, usd);
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
    shown.forEach((p, i) => {
      const snap = views[i]?.card.latestSnapshot as { priceUsd?: number; marketCapUsd?: number } | undefined;
      if (p.entryPriceSol === null || !sol || !snap?.priceUsd || !snap.marketCapUsd) return;
      const supply = snap.marketCapUsd / snap.priceUsd;
      const mcap = p.entryPriceSol * sol * supply;
      if (Number.isFinite(mcap) && mcap > 0) entryMcaps.set(p.mint, mcap);
    });

    // While the panel is open, its open coins stay on the scan (their Now and PnL move with it).
    if (panelOpen) {
      const now = Date.now();
      const ids = shown.flatMap((p) => {
        const t = tokenByMint.get(p.mint);
        if (!t || p.closed) return [];
        const k = `${wallet}:${t.id}`;
        if (now - (stamped.get(k) ?? 0) < STAMP_EVERY_MS) return [];
        stamped.set(k, now);
        return [t.id];
      });
      if (stamped.size > 10_000) stamped.clear();
      if (ids.length > 0) opts.viewStamps.record(ids);
    }

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
    const stats: TradeStats = tradeStats(
      windowRows,
      windowPositions,
      priceSol,
      (mint, at) => callBefore(mint, at) !== null,
      STATS_DAYS,
    );
    return { coins, stats, solUsd: sol ?? null, following: true };
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
