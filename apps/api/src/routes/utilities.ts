import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TokenSnapshot } from "@prisma/client";
import {
  burnCreditPrices,
  creditBalance,
  creditBurnCredits,
  describeCreditRejection,
  lastRebuiltAt,
  LOOKUP_REOPEN_MS,
  openLookup,
  parseCreditBurnTransaction,
  KNOWN_EXCHANGE_WALLETS,
  prisma,
  spendCredits,
  sideWalletRules,
  withApiFeature,
  BURN_CREDIT_MEMO,
  SIDE_GAP_MINUTES,
  SIDE_WINDOWS,
  SUBSCRIPTION_MINT,
  SUBSCRIPTION_MINT_DECIMALS,
  type CandidateToken,
  type SideWindow,
  type DexScreenerClient,
  type SolanaRpc,
  type UtilityKind,
} from "@trenchscanner/core";
import { creatorFeesByMint, TOKEN_CARD_SELECT } from "../curatedFeed.js";
import { readKolRows } from "../kolRoster.js";
import { currentMarketCap } from "./matches.js";
import { readTokenChart, readTokenSage } from "./tokens.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";

/**
 * The Utilities tab: lookups paid for with Burn Credits (core's subscription/credits.ts).
 *
 * - GET  /utilities             the wallet's balance, the prices, and its recent lookups
 * - POST /utilities/claim       credit a Burn Credits burn, read back from the chain
 * - POST /utilities/token       look up any mint: 1 credit, taken only once the lookup succeeds
 * - GET  /utilities/token/:mint the token view of a paid lookup, plus its chart and TokenSage read
 * - POST /utilities/wallet      look up any wallet: 1 credit, taken once its profile loads; the
 *                               dashboard then opens it in the wallet modal (GET /wallets/:wallet)
 * - GET  /utilities/side-wallets         the Side Wallet Checker's KOL leaderboard (free)
 * - GET  /utilities/side-wallets/:wallet one KOL's top side wallets per window (free)
 * - GET  /utilities/side-wallets/:wallet/:side the coins a KOL and one listed wallet bought together,
 *                               leg by leg, with both funders: what a person needs to judge a link
 *
 * A lookup stays open for LOOKUP_REOPEN_MS after it is paid for: the view's own reads, and
 * looking the same thing up again, are free inside it and refused (402) outside it.
 *
 * A token lookup is a fresh scan: the mint is put on Token (if it is new) and stamped as viewed,
 * which keeps the worker scanning it every cycle whatever its market cap (see Token.lastViewedAt),
 * and the worker asks TokenSage for a full read of every mint a utility looked up recently
 * (utilityLookups.ts in the worker). Until the scan lands, the view shows the market data the
 * lookup itself read.
 */

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const mintSchema = z.object({ mint: z.string().regex(ADDRESS_RE, "That isn't a Solana address.") });
const walletSchema = z.object({ wallet: z.string().regex(ADDRESS_RE, "That isn't a Solana address.") });
const claimSchema = z.object({ signature: z.string().regex(SIGNATURE_RE, "invalid transaction signature") });

/** Lookups and claims each spend outside calls (DexScreener, the RPC); a person needs a handful. */
const LOOKUP_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

/** A scan snapshot this close before the lookup still counts as the lookup's fresh scan. */
const FRESH_SCAN_SLACK_MS = 60_000;

/** The market data each lookup read, kept for the view until the scan's own snapshot lands. */
const READINGS_MAX = 500;
const readings = new Map<string, { at: Date; reading: CandidateToken }>();
function keepReading(mint: string, reading: CandidateToken, at: Date): void {
  readings.delete(mint);
  readings.set(mint, { at, reading });
  if (readings.size > READINGS_MAX) {
    const oldest = readings.keys().next().value;
    if (oldest !== undefined) readings.delete(oldest);
  }
}

export interface UtilityRouteOptions {
  dexScreener: DexScreenerClient;
  rpc: SolanaRpc;
  viewStamps: ViewStampBuffer;
  /** The wallet modal's chain reader (null without a Helius key: the profile is what the database knows). */
  walletLive: WalletLiveReader | null;
}

export async function registerUtilityRoutes(app: FastifyInstance, opts: UtilityRouteOptions) {
  // Behind the paywall like the rest of the dashboard (user decision 2026-10-13): lookups cost
  // credits on top of a subscription. Burns from a wallet without one are still credited by the
  // reconciler, and wait for it.
  app.addHook("preHandler", app.authenticateSubscriber);

  /** What the Utilities tab opens with. */
  app.get("/", async (request) => {
    const wallet = request.user!.walletAddress;
    const since = new Date(Date.now() - LOOKUP_REOPEN_MS);
    const [balance, prices, spends, burns] = await Promise.all([
      creditBalance(wallet),
      burnCreditPrices(),
      prisma.burnCreditEntry.findMany({
        where: { wallet, kind: "spend" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { utility: true, subject: true, delta: true, createdAt: true },
      }),
      prisma.burnCreditEntry.findMany({
        where: { wallet, kind: { in: ["burn", "grant"] } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { kind: true, delta: true, burnSignature: true, rawAmount: true, createdAt: true },
      }),
    ]);
    const mints = spends.filter((s) => s.utility === "token" && s.subject).map((s) => s.subject!);
    const tokens = mints.length
      ? await prisma.token.findMany({
          where: { mintAddress: { in: [...new Set(mints)] } },
          select: { mintAddress: true, symbol: true, name: true, imageUrl: true },
        })
      : [];
    const tokenByMint = new Map(tokens.map((t) => [t.mintAddress, t]));
    return {
      balance,
      prices,
      burn: { mint: SUBSCRIPTION_MINT, decimals: SUBSCRIPTION_MINT_DECIMALS, memo: BURN_CREDIT_MEMO },
      reopenMinutes: LOOKUP_REOPEN_MS / 60_000,
      lookups: spends.map((s) => ({
        utility: s.utility,
        subject: s.subject,
        cost: -s.delta,
        at: s.createdAt,
        open: s.createdAt > since,
        token: s.utility === "token" && s.subject ? (tokenByMint.get(s.subject) ?? null) : null,
      })),
      credits: burns,
    };
  });

  /**
   * Credit a Burn Credits burn. The signature names the burn; the chain says how much was burned
   * and from whose tokens, and the credits go to that wallet whoever calls this. Retrying is
   * safe: the ledger's unique signature makes a second claim a no-op.
   */
  app.post("/claim", { config: { rateLimit: LOOKUP_RATE_LIMIT } }, async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { signature } = parsed.data;
    const wallet = request.user!.walletAddress;

    const existing = await prisma.burnCreditEntry.findUnique({
      where: { burnSignature: signature },
      select: { wallet: true },
    });
    if (existing) {
      if (existing.wallet !== wallet) {
        return reply.code(202).send({
          status: "held",
          message: "That burn was made by a different wallet. Sign in with that wallet to use its credits.",
        });
      }
      return { status: "already_credited", balance: await creditBalance(wallet) };
    }

    const tx = await withApiFeature("burn-credits", () => opts.rpc.getParsedTransaction(signature));
    if (!tx) {
      return reply.code(202).send({
        status: "pending",
        message:
          "That burn hasn't finalised yet. This page keeps checking, and your credits are safe either way.",
      });
    }
    const verdict = parseCreditBurnTransaction(tx, signature);
    if (!verdict.ok) {
      return reply.code(400).send({ status: "rejected", error: describeCreditRejection(verdict.reason) });
    }
    const outcome = await creditBurnCredits(signature, verdict.burn, "claim");
    if (verdict.burn.burnerWallet !== wallet) {
      return reply.code(202).send({
        status: "held",
        message: "That burn was made by a different wallet. Sign in with that wallet to use its credits.",
      });
    }
    return {
      status: outcome.status,
      credits: outcome.status === "credited" ? outcome.credits : undefined,
      balance: await creditBalance(wallet),
    };
  });

  /**
   * Look a token up. The credit is taken only after DexScreener (or its fallback) has priced the
   * mint: an address nothing trades costs nothing. Looking the same mint up again inside the
   * re-open window is free.
   */
  app.post("/token", { config: { rateLimit: LOOKUP_RATE_LIMIT } }, async (request, reply) => {
    const parsed = mintSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { mint } = parsed.data;
    const wallet = request.user!.walletAddress;
    const prices = await burnCreditPrices();
    const cost = prices.cost.token;

    const open = await openLookup(wallet, "token", mint);
    if (!open) {
      const balance = await creditBalance(wallet);
      if (balance < cost) return notEnough(reply, balance, cost);
    }

    const failed = new Set<string>();
    const [reading] = await withApiFeature("utility-token", () =>
      opts.dexScreener.getTokensByAddresses([mint], 1, {
        timeoutMs: 5_000,
        retries: 1,
        deadlineMs: 10_000,
        failed,
      }),
    );
    if (!reading || !(reading.marketCapUsd > 0)) {
      if (failed.has(mint)) {
        return reply
          .code(503)
          .send({ error: "Couldn't reach the market data just now. No credit was used; try again shortly." });
      }
      return reply.code(404).send({
        error:
          "No market found for that address. It may not be a token, or it hasn't traded yet. No credit was used.",
      });
    }

    const now = new Date();
    keepReading(mint, reading, now);
    await upsertLookedUpToken(mint, reading, now);

    const spent = await spendCredits(wallet, "token", mint, cost);
    if (spent.status === "insufficient") return notEnough(reply, spent.balance, cost);
    return {
      mint,
      charged: spent.status === "charged" ? spent.cost : 0,
      balance: spent.balance,
    };
  });

  /**
   * Look up a wallet: its profile is loaded (warming the wallet modal's own read) and the credit
   * taken only once that succeeds. The dashboard then opens the wallet modal on it.
   */
  app.post("/wallet", { config: { rateLimit: LOOKUP_RATE_LIMIT } }, async (request, reply) => {
    const parsed = walletSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const subject = parsed.data.wallet;
    const wallet = request.user!.walletAddress;
    const cost = (await burnCreditPrices()).cost.wallet;

    const open = await openLookup(wallet, "wallet", subject);
    if (!open) {
      const balance = await creditBalance(wallet);
      if (balance < cost) return notEnough(reply, balance, cost);
    }

    try {
      await withApiFeature("utility-wallet", () => loadWalletProfile(subject, opts.walletLive));
    } catch (err) {
      request.log.warn({ err, subject }, "utility wallet lookup failed");
      return reply
        .code(503)
        .send({ error: "Couldn't read that wallet just now. No credit was used; try again shortly." });
    }

    const spent = await spendCredits(wallet, "wallet", subject, cost);
    if (spent.status === "insufficient") return notEnough(reply, spent.balance, cost);
    return {
      wallet: subject,
      charged: spent.status === "charged" ? spent.cost : 0,
      balance: spent.balance,
    };
  });

  /**
   * The Side Wallet Checker, free: the KOLs on the roster ranked by tracked coins bought in the
   * last 30 days, from the worker's hourly rebuild (KolSideWallets, kolSideWalletsJob.ts). A read
   * of what is stored: no outside calls.
   */
  app.get("/side-wallets", async (_request, reply) => {
    const rows = await prisma.kolSideWallets.findMany({
      where: { coins30d: { gt: 0 } },
      orderBy: [{ coins30d: "desc" }, { coins7d: "desc" }, { wallet: "asc" }],
      take: SIDE_LEADERBOARD_MAX,
      select: { wallet: true, coins24h: true, coins7d: true, coins30d: true, sides: true, computedAt: true },
    });
    const names = await kolNames(rows.map((r) => r.wallet));
    reply.header("Cache-Control", "private, max-age=300");
    return {
      // The last rebuild: the job rewrites only the KOLs whose lists changed.
      computedAt:
        rows.length > 0
          ? await lastRebuiltAt(
              "kol-side-wallets",
              rows.reduce((t, r) => (r.computedAt > t ? r.computedAt : t), rows[0]!.computedAt),
            )
          : null,
      gapMinutes: SIDE_GAP_MINUTES,
      // Every cutoff the lists and labels are built with (core's wallets/sideWalletRules.ts).
      rules: sideWalletRules(),
      kols: rows.map((r) => {
        const sides = r.sides as Partial<Record<SideWindow, unknown[]>>;
        return {
          wallet: r.wallet,
          name: names.get(r.wallet)?.name ?? null,
          twitter: names.get(r.wallet)?.twitter ?? null,
          // A Known Side of another KOL on the roster (core's KOL_MAINS): its main wallet and name.
          knownSideOf: names.get(r.wallet)?.knownSideOf ?? null,
          coins: { "24h": r.coins24h, "7d": r.coins7d, "30d": r.coins30d },
          sides: {
            "24h": sides["24h"]?.length ?? 0,
            "7d": sides["7d"]?.length ?? 0,
            "30d": sides["30d"]?.length ?? 0,
          },
        };
      }),
    };
  });

  /** One KOL's top side wallets in each window, with the risk labels each carries. */
  app.get("/side-wallets/:wallet", async (request, reply) => {
    const kol = (request.params as { wallet?: string }).wallet ?? "";
    if (!ADDRESS_RE.test(kol)) return reply.code(400).send({ error: "not a valid address" });
    const row = await prisma.kolSideWallets.findUnique({ where: { wallet: kol } });
    if (!row) return reply.code(404).send({ error: "That wallet isn't on the KOL leaderboard." });
    const stored = row.sides as Partial<Record<SideWindow, StoredSideWallet[]>>;
    const sides = Object.fromEntries(SIDE_WINDOWS.map((w) => [w, stored[w] ?? []])) as Record<
      SideWindow,
      StoredSideWallet[]
    >;
    const wallets = [...new Set(SIDE_WINDOWS.flatMap((w) => sides[w].map((s) => s.wallet)))];
    const [risk, names] = await Promise.all([
      wallets.length
        ? prisma.walletRisk.findMany({
            where: { wallet: { in: wallets } },
            select: { wallet: true, score: true, dumper: true, winner: true, sniper: true },
          })
        : [],
      kolNames([kol]),
    ]);
    const riskBy = new Map(risk.map((r) => [r.wallet, r]));
    const withRisk = (s: StoredSideWallet) => {
      const r = riskBy.get(s.wallet);
      return {
        ...s,
        risk: r ? { score: Math.round(r.score), dumper: r.dumper, winner: r.winner, sniper: r.sniper } : null,
      };
    };
    reply.header("Cache-Control", "private, max-age=300");
    return {
      wallet: kol,
      name: names.get(kol)?.name ?? null,
      twitter: names.get(kol)?.twitter ?? null,
      computedAt: await lastRebuiltAt("kol-side-wallets", row.computedAt),
      coins: { "24h": row.coins24h, "7d": row.coins7d, "30d": row.coins30d },
      sides: Object.fromEntries(SIDE_WINDOWS.map((w) => [w, sides[w].map(withRisk)])),
      // Wallets taken off this KOL's lists as likely bots (strongly matched with 4+ KOLs).
      likelyBots: (row.sides as { likelyBots?: string[] }).likelyBots ?? [],
      rules: sideWalletRules(),
    };
  });

  /**
   * One KOL and one listed wallet, coin by coin (user ask 2026-10-14): every tracked coin both first
   * bought within the gap in the window, each leg's buys, sells, SOL and launch roles, and who
   * funded each wallet. Read from what is stored: no outside calls.
   */
  app.get("/side-wallets/:wallet/:side", async (request, reply) => {
    const { wallet: kol = "", side = "" } = request.params as { wallet?: string; side?: string };
    if (!ADDRESS_RE.test(kol) || !ADDRESS_RE.test(side) || kol === side)
      return reply.code(400).send({ error: "not a valid pair of addresses" });
    const windowParam = (request.query as { window?: string }).window ?? "30d";
    const window = (SIDE_WINDOWS as readonly string[]).includes(windowParam)
      ? (windowParam as SideWindow)
      : "30d";
    const kolRow = await prisma.kolWallet.findUnique({ where: { wallet: kol }, select: { wallet: true } });
    if (!kolRow) return reply.code(404).send({ error: "That wallet isn't on the KOL roster." });

    const since = new Date(Date.now() - SIDE_WINDOW_MS[window]);
    const gapSeconds = SIDE_GAP_MINUTES * 60;
    const rows = await prisma.$queryRaw<SideMatchRow[]>`
      SELECT t."mintAddress" AS mint, t."symbol", t."name", t."imageUrl",
             k."firstBuyAt" AS "kFirstBuyAt", k."firstSellAt" AS "kFirstSellAt", k."buys" AS "kBuys",
             k."sells" AS "kSells", k."solIn" AS "kSolIn", k."solOut" AS "kSolOut",
             k."boughtPct" AS "kBoughtPct", k."firstBuyerRank" AS "kRank", k."launchSniper" AS "kSniper",
             k."fastExit" AS "kFastExit",
             s."firstBuyAt" AS "sFirstBuyAt", s."firstSellAt" AS "sFirstSellAt", s."buys" AS "sBuys",
             s."sells" AS "sSells", s."solIn" AS "sSolIn", s."solOut" AS "sSolOut",
             s."boughtPct" AS "sBoughtPct", s."firstBuyerRank" AS "sRank", s."launchSniper" AS "sSniper",
             s."fastExit" AS "sFastExit"
      FROM "TokenWalletActivity" k
      JOIN "TokenTradeTape" tape ON tape."tokenId" = k."tokenId" AND tape."status" IN ('done', 'partial')
      JOIN "TokenWalletActivity" s
        ON s."tokenId" = k."tokenId"
       AND s."wallet" = ${side}
       AND s."buys" > 0
       AND s."firstBuyAt" BETWEEN k."firstBuyAt" - make_interval(secs => ${gapSeconds})
                              AND k."firstBuyAt" + make_interval(secs => ${gapSeconds})
      JOIN "Token" t ON t."id" = k."tokenId"
      WHERE k."wallet" = ${kol} AND k."buys" > 0 AND k."firstBuyAt" >= ${since}
      ORDER BY k."firstBuyAt" DESC
      LIMIT ${SIDE_MATCH_MAX}`;
    const [kolCoins, funders, names] = await Promise.all([
      prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n
        FROM "TokenWalletActivity" a
        JOIN "TokenTradeTape" tape ON tape."tokenId" = a."tokenId" AND tape."status" IN ('done', 'partial')
        WHERE a."wallet" = ${kol} AND a."buys" > 0 AND a."firstBuyAt" >= ${since}`,
      prisma.walletFunder.findMany({
        where: { wallet: { in: [kol, side] } },
        select: { wallet: true, status: true, funder: true, amountSol: true, fundedAt: true },
      }),
      kolNames([kol]),
    ]);
    const funderOf = (w: string) => {
      const f = funders.find((x) => x.wallet === w);
      return f
        ? {
            status: f.status,
            funder: f.funder,
            exchange: f.funder ? (KNOWN_EXCHANGE_WALLETS.get(f.funder) ?? null) : null,
            amountSol: f.amountSol,
            fundedAt: f.fundedAt,
          }
        : null;
    };
    const kf = funderOf(kol);
    const sf = funderOf(side);
    const trades = rows.map(sideMatchTrade);
    reply.header("Cache-Control", "private, max-age=300");
    return {
      kol: { wallet: kol, name: names.get(kol)?.name ?? null, funding: kf },
      side: { wallet: side, funding: sf },
      window,
      gapMinutes: SIDE_GAP_MINUTES,
      kolCoins: Number(kolCoins[0]?.n ?? 0),
      fundingLink: fundingLink(kol, side, kf?.funder ?? null, sf?.funder ?? null),
      summary: sideMatchSummary(trades),
      trades,
      truncated: rows.length >= SIDE_MATCH_MAX,
    };
  });

  /** A paid lookup's token view: the card the modal draws, and whether the fresh scan has landed. */
  app.get("/token/:mint", async (request, reply) => {
    const lookup = await paidLookup(request.params, request.user!.walletAddress, "token");
    if ("error" in lookup) return reply.code(lookup.code).send({ error: lookup.error });
    const view = await tokenView(lookup.subject, lookup.paidAt);
    if (!view) return reply.code(404).send({ error: "token not found" });
    // Keeps the worker scanning it while the view is open, as the feeds do for their cards.
    opts.viewStamps.record([view.card.tokenId]);
    return view;
  });

  app.get("/token/:mint/chart", async (request, reply) => {
    const lookup = await paidLookup(request.params, request.user!.walletAddress, "token");
    if ("error" in lookup) return reply.code(lookup.code).send({ error: lookup.error });
    reply.header("Cache-Control", "private, max-age=15");
    return readTokenChart(lookup.subject);
  });

  app.get("/token/:mint/sage", async (request, reply) => {
    const lookup = await paidLookup(request.params, request.user!.walletAddress, "token");
    if ("error" in lookup) return reply.code(lookup.code).send({ error: lookup.error });
    return readTokenSage(lookup.subject);
  });
}

const SIDE_LEADERBOARD_MAX = 200;
/** Most coins one KOL/wallet comparison lists, newest first. */
const SIDE_MATCH_MAX = 200;
const SIDE_WINDOW_MS: Record<SideWindow, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** One coin both wallets bought within the gap, as the comparison query reads it. */
interface SideMatchRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  kFirstBuyAt: Date;
  kFirstSellAt: Date | null;
  kBuys: number;
  kSells: number;
  kSolIn: number;
  kSolOut: number;
  kBoughtPct: number | null;
  kRank: number | null;
  kSniper: boolean;
  kFastExit: boolean;
  sFirstBuyAt: Date;
  sFirstSellAt: Date | null;
  sBuys: number;
  sSells: number;
  sSolIn: number;
  sSolOut: number;
  sBoughtPct: number | null;
  sRank: number | null;
  sSniper: boolean;
  sFastExit: boolean;
}

/** One wallet's side of a shared coin. */
export interface SideMatchLeg {
  firstBuyAt: Date;
  firstSellAt: Date | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** % of supply it bought; null when not read. */
  boughtPct: number | null;
  /** 1-25 among the launch's first buyers, else null. */
  firstBuyerRank: number | null;
  launchSniper: boolean;
  fastExit: boolean;
}

export interface SideMatchTrade {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  kol: SideMatchLeg;
  side: SideMatchLeg;
  /** Seconds from the KOL's first buy to the wallet's (negative: the wallet bought first). */
  gapSec: number;
  /** Seconds from the KOL's first sell to the wallet's, when both sold. */
  sellGapSec: number | null;
}

function sideMatchTrade(r: SideMatchRow): SideMatchTrade {
  const kol: SideMatchLeg = {
    firstBuyAt: r.kFirstBuyAt,
    firstSellAt: r.kFirstSellAt,
    buys: Number(r.kBuys),
    sells: Number(r.kSells),
    solIn: Number(r.kSolIn),
    solOut: Number(r.kSolOut),
    boughtPct: r.kBoughtPct,
    firstBuyerRank: r.kRank,
    launchSniper: r.kSniper,
    fastExit: r.kFastExit,
  };
  const side: SideMatchLeg = {
    firstBuyAt: r.sFirstBuyAt,
    firstSellAt: r.sFirstSellAt,
    buys: Number(r.sBuys),
    sells: Number(r.sSells),
    solIn: Number(r.sSolIn),
    solOut: Number(r.sSolOut),
    boughtPct: r.sBoughtPct,
    firstBuyerRank: r.sRank,
    launchSniper: r.sSniper,
    fastExit: r.sFastExit,
  };
  return {
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    imageUrl: r.imageUrl,
    kol,
    side,
    gapSec: Math.round((side.firstBuyAt.getTime() - kol.firstBuyAt.getTime()) / 1000),
    sellGapSec:
      kol.firstSellAt && side.firstSellAt
        ? Math.round((side.firstSellAt.getTime() - kol.firstSellAt.getTime()) / 1000)
        : null,
  };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Seconds within which two first sells read as one exit. */
export const SIDE_EXIT_TOGETHER_SEC = 5 * 60;

/**
 * The patterns a person weighs when judging a link, over the shared coins: which wallet buys
 * first, how close, whether they exit together, and how the sizes compare. Exported for tests.
 */
export function sideMatchSummary(trades: readonly SideMatchTrade[]) {
  const gaps = trades.map((t) => t.gapSec);
  const bothSold = trades.filter((t) => t.sellGapSec !== null);
  const ratios = trades.filter((t) => t.kol.solIn > 0).map((t) => t.side.solIn / t.kol.solIn);
  return {
    shared: trades.length,
    medianGapSec: median(gaps),
    /** Coins the wallet bought before the KOL, within a second of it, and after it. */
    before: gaps.filter((g) => g < -1).length,
    sameSecond: gaps.filter((g) => Math.abs(g) <= 1).length,
    after: gaps.filter((g) => g > 1).length,
    bothSold: bothSold.length,
    exitedTogether: bothSold.filter((t) => Math.abs(t.sellGapSec!) <= SIDE_EXIT_TOGETHER_SEC).length,
    medianSellGapSec: median(bothSold.map((t) => t.sellGapSec!)),
    /** The wallet's SOL in over the KOL's, per coin, at the median. */
    medianSizeRatio: median(ratios),
    kolSolIn: trades.reduce((n, t) => n + t.kol.solIn, 0),
    sideSolIn: trades.reduce((n, t) => n + t.side.solIn, 0),
    kolPnlSol: trades.reduce((n, t) => n + t.kol.solOut - t.kol.solIn, 0),
    sidePnlSol: trades.reduce((n, t) => n + t.side.solOut - t.side.solIn, 0),
  };
}

/** How the two wallets' funders tie them, if they do. Exported for tests. */
export function fundingLink(
  kol: string,
  side: string,
  kolFunder: string | null,
  sideFunder: string | null,
): "same-funder" | "kol-funded-wallet" | "wallet-funded-kol" | "exchange" | null {
  if (sideFunder && sideFunder === kol) return "kol-funded-wallet";
  if (kolFunder && kolFunder === side) return "wallet-funded-kol";
  if (kolFunder && sideFunder && kolFunder === sideFunder)
    return KNOWN_EXCHANGE_WALLETS.has(kolFunder) ? "exchange" : "same-funder";
  return null;
}

/** One side wallet as the worker stores it (SideWallet in kolSideWalletsJob.ts). */
interface StoredSideWallet {
  wallet: string;
  shared: number;
  pct: number;
  coins: number;
  gapSec: number;
}

async function kolNames(wallets: string[]): Promise<
  Map<
    string,
    {
      name: string | null;
      twitter: string | null;
      knownSideOf: { wallet: string; name: string | null } | null;
    }
  >
> {
  const rows = await readKolRows(wallets);
  return new Map(
    [...rows.values()].map((r) => [r.wallet, { name: r.name, twitter: r.twitter, knownSideOf: r.main }]),
  );
}

function notEnough(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } },
  balance: number,
  cost: number,
) {
  return reply.code(402).send({
    error: `This lookup costs ${cost} Burn Credit${cost === 1 ? "" : "s"} and you have ${balance}. Burn $ASDFASDFA to get more.`,
    code: "not_enough_credits",
    balance,
    cost,
  });
}

/** The wallet's open lookup of the address in the route, or why there isn't one. */
async function paidLookup(
  params: unknown,
  wallet: string,
  utility: UtilityKind,
): Promise<{ subject: string; paidAt: Date } | { code: number; error: string }> {
  const raw = (params as { mint?: string; wallet?: string }).mint ?? (params as { wallet?: string }).wallet;
  if (!raw || !ADDRESS_RE.test(raw)) return { code: 400, error: "not a valid address" };
  const open = await openLookup(wallet, utility, raw);
  if (!open)
    return { code: 402, error: "Look this up again to open it: the free re-open window has passed." };
  return { subject: raw, paidAt: open.paidAt };
}

/**
 * Puts a looked-up mint on Token, from the lookup's own reading, and stamps it as viewed so the
 * next scan cycle scans it. A mint already there keeps its row: only the view stamp and the live
 * market data move.
 */
async function upsertLookedUpToken(mint: string, reading: CandidateToken, now: Date): Promise<void> {
  const live = {
    lastViewedAt: now,
    liveMarketCapUsd: reading.marketCapUsd,
    livePriceUsd: reading.priceUsd > 0 ? reading.priceUsd : null,
    liveDataAt: now,
  };
  await prisma.token.upsert({
    where: { mintAddress: mint },
    update: live,
    create: {
      mintAddress: mint,
      symbol: reading.symbol,
      name: reading.name,
      imageUrl: reading.imageUrl,
      pairAddress: reading.pairAddress,
      firstSeenAt:
        reading.pairCreatedAt instanceof Date && !Number.isNaN(reading.pairCreatedAt.getTime())
          ? reading.pairCreatedAt
          : now,
      hasTwitter: reading.hasTwitter ?? false,
      hasTelegram: reading.hasTelegram ?? false,
      hasWebsite: reading.hasWebsite ?? false,
      discoverySource: "utility",
      ...live,
    },
  });
}

export interface UtilityTokenView {
  mint: string;
  paidAt: Date;
  /** "scanning" until a scan snapshot from the lookup on has landed; the card shows the lookup's reading meanwhile. */
  scan: "scanning" | "scanned";
  card: {
    id: string;
    kind: "stream";
    tokenId: string;
    matchedAt: Date;
    score: number;
    peakReturnPct: null;
    token: Record<string, unknown>;
    snapshot: unknown;
    latestSnapshot: unknown;
    currentMarketCapUsd: number | null;
    currentMarketCapAt: Date | null;
    filter: null;
    curated: null;
    outcome: null;
  };
}

/**
 * The token view of a lookup, shaped as a feed card (kind "stream": no filter, no call) so the
 * dashboard draws it with the feed's own token modal. Its snapshot is the newest scan; before the
 * first scan of a new mint it is a stand-in built from the lookup's market data.
 */
export async function tokenView(mint: string, paidAt: Date): Promise<UtilityTokenView | null> {
  const [token, fees] = await Promise.all([
    prisma.token.findUnique({ where: { mintAddress: mint }, select: TOKEN_CARD_SELECT }),
    creatorFeesByMint([mint]),
  ]);
  if (!token) return null;
  const latest = await prisma.tokenSnapshot.findFirst({
    where: { tokenId: token.id },
    orderBy: { takenAt: "desc" },
  });
  const scanned = latest !== null && latest.takenAt.getTime() >= paidAt.getTime() - FRESH_SCAN_SLACK_MS;
  const snapshot = latest ?? standIn(token, readings.get(mint));
  const current = currentMarketCap(token, latest);
  return {
    mint,
    paidAt,
    scan: scanned ? "scanned" : "scanning",
    card: {
      id: `utility-${token.id}`,
      kind: "stream",
      tokenId: token.id,
      matchedAt: snapshot.takenAt,
      score: snapshot.score ?? 0,
      peakReturnPct: null,
      token: { ...token, creatorFee: fees.get(mint) ?? null },
      snapshot,
      latestSnapshot: snapshot,
      currentMarketCapUsd: current.marketCapUsd,
      currentMarketCapAt: current.at,
      filter: null,
      curated: null,
      outcome: null,
    },
  };
}

type StandIn = Pick<TokenSnapshot, "takenAt" | "marketCapUsd" | "priceUsd" | "score"> &
  Record<string, unknown>;

/** A snapshot-shaped reading from the lookup's market data, for a mint not yet scanned. */
function standIn(
  token: {
    firstSeenAt: Date;
    liveMarketCapUsd: number | null;
    livePriceUsd: number | null;
    liveDataAt: Date | null;
  },
  kept: { at: Date; reading: CandidateToken } | undefined,
): StandIn {
  const r = kept?.reading;
  const takenAt = kept?.at ?? token.liveDataAt ?? new Date();
  const marketCapUsd = r?.marketCapUsd ?? token.liveMarketCapUsd ?? 0;
  const created = r?.pairCreatedAt ?? token.firstSeenAt;
  return {
    takenAt,
    priceUsd: r?.priceUsd ?? token.livePriceUsd ?? 0,
    marketCapUsd,
    liquidityUsd: r?.liquidityUsd ?? null,
    volume24hUsd: r?.volume24hUsd ?? null,
    volumeToMcapRatio: r?.volume24hUsd != null && marketCapUsd > 0 ? r.volume24hUsd / marketCapUsd : null,
    buys24h: r?.buys24h ?? null,
    sells24h: r?.sells24h ?? null,
    holderCount: null,
    holderGrowthPct: null,
    top10HolderPct: null,
    devWalletPct: null,
    riskScore: null,
    freshTop10WalletPct: null,
    ageMinutes: created ? Math.max(0, (takenAt.getTime() - created.getTime()) / 60_000) : null,
    graduated: null,
    score: null,
    volume5mUsd: r?.volume5mUsd ?? null,
    volume1hUsd: r?.volume1hUsd ?? null,
  };
}
