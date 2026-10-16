import type { FastifyInstance } from "fastify";
import { allowLookupRead } from "../lookupGate.js";
import { keepFilterMoment, readBubbleMoments, type BubbleMomentView } from "../bubbleMoments.js";
import { readKolRows } from "../kolRoster.js";
import {
  isStonksCoin,
  NARRATIVE_CONTESTANT,
  Prisma,
  prisma,
  RISKY_WALLET_SCORE,
  STONKS_FEE_WALLET,
  STONKS_FEE_WALLET_LABEL,
  type Env,
  type HeliusClient,
  type TokenSageAnalysis,
} from "@trenchscanner/core";
import { SharedCache } from "../sharedCache.js";
import { readTokenWhy, type TokenWhy } from "../tokenWhy.js";
import { readTokenProfile, type TokenProfile } from "../tokenProfile.js";
import {
  CandleCache,
  KeyedCache,
  type CandleFetcher,
  markedWallets,
  parseLiveTrades,
  pumpFunCandleFetcher,
  withLiveTrades,
  type MarkedWallet,
  type McapCandle,
} from "../tokenChart.js";
import {
  sageNarrative,
  sageRead,
  sageTrack,
  type DayLabelRow,
  type NarrativeAlertRow,
  type SageView,
} from "../tokenSageView.js";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Market cap points drawn in the TokenSage view's chart (the newest scans). */
const SAGE_CHART_POINTS = 120;

/** The week of narrative records behind the TokenSage view: the same for every token, moves hourly. */
const TRACK_DAYS = 7;
const TRACK_CACHE_MS = 10 * 60_000;

/** Scan market caps sent with the token modal's chart: its fallback when Pump.fun has no candles. */
const CHART_SNAPSHOT_POINTS = 240;

/** GET /tokens/:mint/bubble-holders: a model-alerted coin's bubble map over its top 50 (web src/bubbleMap.ts). */
export interface BubbleHoldersMap {
  readAt: string;
  holdersRead: number;
  knownExtra: number;
  holders: { wallet: string; pct: number; rank?: number; cexFunder?: string }[];
  clusters: {
    funder: string;
    wallets: { wallet: string; pct: number }[];
    pct: number;
    creatorLinked: boolean;
  }[];
  /** The clusters without holder-to-holder transfers, when transfers changed them (user ask 2026-10-16). */
  clustersExTransfers?: BubbleHoldersMap["clusters"];
  sameTimeClusters: {
    atMs: number;
    spanMs: number;
    wallets: { wallet: string; pct: number; fundedAtMs: number; funder: string | null }[];
    pct: number;
  }[];
}
export interface BubbleHolders {
  map: BubbleHoldersMap | null;
  /**
   * The map as it stood at the coin's first model call (BubbleMapAtAlert): kept once, never
   * updated. Null for a coin with none (never called, or called before it was kept).
   */
  atAlert: (BubbleHoldersMap & { alertAt: string }) | null;
  /**
   * The maps kept at the coin's first safety-screen pass and at filters' first catches
   * (BubbleMapMoment), the ones this reader may see, oldest first.
   */
  moments: BubbleMomentView[];
}

/** A stored map row (BubbleMapHolders or BubbleMapAtAlert) as the API sends it. */
function bubbleMapOf(row: {
  readAt: Date;
  holdersRead: number;
  knownExtra: number;
  holders: unknown;
  clusters: unknown;
  clustersExTransfers?: unknown;
  sameTimeClusters: unknown;
}): BubbleHoldersMap {
  return {
    readAt: row.readAt.toISOString(),
    holdersRead: row.holdersRead,
    knownExtra: row.knownExtra,
    holders: row.holders as BubbleHoldersMap["holders"],
    clusters: row.clusters as BubbleHoldersMap["clusters"],
    ...(Array.isArray(row.clustersExTransfers)
      ? { clustersExTransfers: row.clustersExTransfers as BubbleHoldersMap["clusters"] }
      : {}),
    sameTimeClusters: row.sameTimeClusters as BubbleHoldersMap["sameTimeClusters"],
  };
}

/** GET /tokens/:mint/chart: the token modal's price chart (web src/components/TokenModal.tsx). */
export interface TokenChart {
  mint: string;
  /** Pump.fun's one-minute candles as market cap, oldest first; null when unavailable. */
  candles: McapCandle[] | null;
  /**
   * The scan's market-cap readings, oldest first: drawn when there are no candles. Each carries the
   * buys and sells DexScreener counted in the 5 minutes before it, when it had them.
   */
  marketCap: { t: number; usd: number; buys: number | null; sells: number | null }[];
  /** The coin's trade tape (TokenTradeTape): null until it is read, which is only for called coins. */
  tape: { status: string; anchorAt: number; windowEnd: number; readAt: number } | null;
  /**
   * When the newest live-tape reading was taken (the coin's newest trades, read before a call):
   * null when its trades were never read live.
   */
  live: { readAt: number } | null;
  /** Flagged wallets in the live readings and the tape, with their trades to mark. */
  wallets: MarkedWallet[];
}

/** Snapshots whose live-tape readings the chart folds in, newest first: hours of a busy coin. */
const LIVE_SNAPSHOTS = 60;

/** One coin's flagged wallets change hourly at most (scores) or once (the tape): a minute's reuse. */
const WALLETS_CACHE_MS = 60_000;

/** One per process: every reader of a coin shares its Pump.fun call and the call budget. */
let candleCache = new CandleCache(pumpFunCandleFetcher());

/** Tests: where the chart's candles come from, instead of Pump.fun. */
export function setCandleFetcherForTests(fetcher: CandleFetcher): void {
  candleCache = new CandleCache(fetcher);
}
type ChartWallets = Pick<TokenChart, "tape" | "live" | "wallets">;
const walletCache = new KeyedCache<ChartWallets>(WALLETS_CACHE_MS);

/**
 * The coin's flagged wallets and their trades: the risky wallets and known dumpers the live tape
 * read before the call (TokenSnapshot.flaggedTrades), then everything the post-call trade tape
 * read (TokenWalletActivity), with the wallet risk scores (WalletRisk) and the linked clusters on
 * its newest snapshot that has them.
 */
async function chartWallets(tokenId: string): Promise<ChartWallets> {
  const [tape, rows, clustered, liveSnaps] = await Promise.all([
    prisma.tokenTradeTape.findUnique({
      where: { tokenId },
      select: { status: true, anchorAt: true, windowEnd: true, readAt: true },
    }),
    prisma.tokenWalletActivity.findMany({
      where: { tokenId },
      select: {
        wallet: true,
        isCreator: true,
        solIn: true,
        solOut: true,
        heldPctAtAnchor: true,
        firstBuyAt: true,
        firstSellAt: true,
        trades: true,
      },
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, linkedClusters: { not: Prisma.DbNull } },
      orderBy: { takenAt: "desc" },
      select: { linkedClusters: true },
    }),
    // A reading with no flagged trades still counts: it says none traded before the call.
    prisma.tokenSnapshot.findMany({
      where: { tokenId, flaggedBuyers: { not: null } },
      orderBy: { takenAt: "desc" },
      take: LIVE_SNAPSHOTS,
      select: { takenAt: true, flaggedTrades: true },
    }),
  ]);
  const live = liveSnaps.flatMap((s) => parseLiveTrades(s.flaggedTrades));
  const wallets = [...new Set([...rows.map((r) => r.wallet), ...live.map((t) => t.wallet)])];
  const scores =
    wallets.length > 0
      ? await prisma.walletRisk.findMany({
          where: { wallet: { in: wallets } },
          select: {
            wallet: true,
            score: true,
            dumps: true,
            appearances: true,
            dumper: true,
            winner: true,
          },
        })
      : [];
  const risk = new Map(scores.map((w) => [w.wallet, w]));
  const kolRows = await readKolRows(rows.map((r) => r.wallet));
  // A Known Side goes by its KOL's name, and says it is a side (knownSideOf).
  const kols = new Map([...kolRows.values()].map((k) => [k.wallet, k.main ? k.main.name : k.name]));
  const knownSides = new Map(
    [...kolRows.values()].flatMap((k) => (k.main ? [[k.wallet, k.main.wallet] as const] : [])),
  );
  const opts = { riskyScore: RISKY_WALLET_SCORE };
  const clusters = Array.isArray(clustered?.linkedClusters)
    ? (clustered.linkedClusters as { funder: string; wallets: { wallet: string }[] }[]).filter(
        (c) => typeof c?.funder === "string" && Array.isArray(c.wallets),
      )
    : [];
  return {
    tape: tape
      ? {
          status: tape.status,
          anchorAt: tape.anchorAt.getTime(),
          windowEnd: tape.windowEnd.getTime(),
          readAt: tape.readAt.getTime(),
        }
      : null,
    live: liveSnaps[0] ? { readAt: liveSnaps[0].takenAt.getTime() } : null,
    wallets: withLiveTrades(markedWallets(rows, risk, clusters, opts, kols, knownSides), live, risk, opts),
  };
}

/** GET /tokens/:mint/stonk-fees: Stonks' fee wallet's share of a Stonks coin (core's stonksFees.ts). */
export interface StonkFees {
  /** Whether the coin is a Stonks launch; the rest is only read for one. */
  stonks: boolean;
  wallet: string;
  label: string;
  /** % of supply the fee wallet holds now; null when the chain read had no answer. */
  pct: number | null;
}

type StonkFeesReader = Pick<HeliusClient, "getWalletShareOfMint">;

/** The fee wallet's share moves with every sweep: a minute's reuse per coin. */
const stonkFeesCache = new KeyedCache<{ pct: number; withheldFeeAuthority?: string }>(60_000);

/**
 * The fee wallet's share for the token modal's card. Only coins the scanner tracks, and only a
 * chain read for one whose launchpad is Stonks or not recorded (then its mint's withheld-fee
 * authority decides): a Pump.fun coin's answer is known without one. Exported for tests.
 */
export async function readStonkFees(
  mintAddress: string,
  reader: StonkFeesReader | null,
  launchpad: string | null | undefined,
): Promise<StonkFees> {
  const out = { stonks: false, wallet: STONKS_FEE_WALLET, label: STONKS_FEE_WALLET_LABEL, pct: null };
  const known = isStonksCoin({ launchpad });
  if (!known && launchpad) return out;
  if (!reader) return { ...out, stonks: known };
  const read = await stonkFeesCache
    .get(mintAddress, async () => {
      const r = await reader.getWalletShareOfMint(STONKS_FEE_WALLET, mintAddress);
      // Thrown, not returned: a read without an answer isn't kept for the minute.
      if (!r) throw new Error("no answer");
      return r;
    })
    .catch(() => null);
  const stonks = known || isStonksCoin({ withheldFeeAuthority: read?.withheldFeeAuthority });
  return { ...out, stonks, pct: stonks && read ? read.pct : null };
}

/**
 * Token detail is not user-specific (it's the same underlying market data for
 * everyone), but still requires auth since it's part of the product surface
 * rather than a public API - keeps scope aligned with "multiple users,
 * individual filters" rather than an open public tool.
 */
export async function registerTokenRoutes(
  app: FastifyInstance,
  opts: { env?: Env; stonkFees?: StonkFeesReader | null } = {},
) {
  // Token detail is reached from the paid feed. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:mintAddress", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) return reply.code(400).send({ error: "not a valid mint" });
    // A coin the scanner doesn't track on its own needs the reader's paid lookup (lookupGate.ts).
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return reply;
    const row = await prisma.token.findUnique({ where: { mintAddress } });
    if (!row) {
      return reply.code(404).send({ error: "token not found" });
    }
    // Its own query rather than a nested `snapshots: { take: 50 }` include: Prisma doesn't
    // reliably push a nested take down as SQL LIMIT, and TokenSnapshot is the largest table.
    // A direct take on the (tokenId, takenAt) index is a bounded index walk.
    // Everything but the AI text scores: model inputs, not display data (the cards omit them too).
    const { aiTextScores: _scores, aiTextScoredAt: _scoredAt, ...token } = row;
    const snapshots = await prisma.tokenSnapshot.findMany({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
      take: 50,
    });
    return { ...token, snapshots };
  });

  /** The token modal's chart: Pump.fun's minute candles, with the scan's market caps behind them. */
  app.get("/:mintAddress/chart", async (request, reply): Promise<TokenChart | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    // The browser may reuse it for a few seconds; the candles themselves are cached here for 30.
    reply.header("Cache-Control", "private, max-age=15");
    return readTokenChart(mintAddress);
  });

  /**
   * A model-alerted coin's bubble map over its top 50 holders (BubbleMapHolders): the top 25 and
   * every known wallet past them, clustered alike, now and as it stood at the coin's first call.
   * Null for either the coin has none of.
   */
  app.get("/:mintAddress/bubble-holders", async (request, reply): Promise<BubbleHolders | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    reply.header("Cache-Control", "private, max-age=30");
    const [row, frozen, moments] = await Promise.all([
      prisma.bubbleMapHolders.findUnique({ where: { mintAddress } }),
      prisma.bubbleMapAtAlert.findUnique({ where: { mintAddress } }),
      readBubbleMoments(mintAddress, request.user?.userId),
    ]);
    return {
      map: row ? bubbleMapOf(row) : null,
      atAlert: frozen ? { ...bubbleMapOf(frozen), alertAt: frozen.alertAt.toISOString() } : null,
      moments,
    };
  });

  /**
   * The reader opened one of their filter's alerts on the coin (`matchId`): keeps the coin's map at
   * their filter's first catch of it, once (keepFilterMoment). Answers what happened.
   */
  app.post("/:mintAddress/bubble-moments/filter", async (request, reply) => {
    const { mintAddress } = request.params as { mintAddress: string };
    const matchId = (request.body as { matchId?: unknown } | null)?.matchId;
    if (
      !MINT_RE.test(mintAddress) ||
      typeof matchId !== "string" ||
      matchId.length === 0 ||
      matchId.length > 64
    ) {
      reply.code(400).send({ error: "needs a mint and a matchId" });
      return;
    }
    return { result: await keepFilterMoment(mintAddress, request.user!.userId, matchId) };
  });

  /** Stonks' fee wallet's share of the coin, for the token modal's card; `stonks: false` for any other coin. */
  app.get("/:mintAddress/stonk-fees", async (request, reply): Promise<StonkFees | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    const token = await prisma.token.findUnique({ where: { mintAddress }, select: { launchpad: true } });
    reply.header("Cache-Control", "private, max-age=30");
    if (!token)
      return { stonks: false, wallet: STONKS_FEE_WALLET, label: STONKS_FEE_WALLET_LABEL, pct: null };
    return readStonkFees(mintAddress, opts.stonkFees ?? null, token.launchpad);
  });

  /**
   * Why the models did or didn't call the coin (tokenWhy.ts), at its decision moment at or before
   * `at` (ms; a call's time), else its newest one. Asked for when the reader opens it.
   */
  app.get("/:mintAddress/why", async (request, reply): Promise<TokenWhy | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    const raw = (request.query as { at?: string } | undefined)?.at;
    const at = raw === undefined ? null : Number(raw);
    if (!MINT_RE.test(mintAddress) || (at !== null && !(Number.isFinite(at) && at > 0))) {
      reply.code(400).send({ error: "needs a mint and, optionally, a time in ms" });
      return;
    }
    if (!opts.env) {
      reply.code(404).send({ error: "not available" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const why = await readTokenWhy(opts.env, mintAddress, at);
    if (!why) {
      reply.code(404).send({ error: "token not found" });
      return;
    }
    reply.header("Cache-Control", "private, max-age=60");
    return why;
  });

  /** The token modal's Dev, Socials and Order flow cards (tokenProfile.ts). */
  app.get("/:mintAddress/profile", async (request, reply): Promise<TokenProfile | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const profile = await readTokenProfile(mintAddress);
    if (!profile) {
      reply.code(404).send({ error: "token not found" });
      return;
    }
    reply.header("Cache-Control", "private, max-age=30");
    return profile;
  });

  /** TokenSage's read of the token, for the card's TokenSage view (src/tokenSageView.ts). */
  app.get("/:mintAddress/sage", async (request, reply): Promise<SageView | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    return readTokenSage(mintAddress);
  });
}

/**
 * The token modal's chart for one mint (GET /tokens/:mint/chart, and the Utilities tab's token
 * lookup): Pump.fun's minute candles, the scan's market caps, and the coin's flagged wallets.
 */
export async function readTokenChart(mintAddress: string): Promise<TokenChart> {
  // Token first: Pump.fun's candles are read only for a coin on Token, so a loop over random mints
  // can't spend the shared candle budget everyone's token modal draws from.
  const token = await prisma.token.findUnique({ where: { mintAddress }, select: { id: true } });
  const [candles, snapshots, flagged] = token
    ? await Promise.all([
        candleCache.get(mintAddress),
        prisma.tokenSnapshot.findMany({
          where: { tokenId: token.id },
          orderBy: { takenAt: "desc" },
          take: CHART_SNAPSHOT_POINTS,
          select: { takenAt: true, marketCapUsd: true, buys5m: true, sells5m: true },
        }),
        walletCache.get(token.id, () => chartWallets(token.id)),
      ])
    : [null, [], { tape: null, live: null, wallets: [] }];
  return {
    mint: mintAddress,
    candles: candles && candles.length > 0 ? candles : null,
    marketCap: snapshots
      .filter((s) => Number.isFinite(s.marketCapUsd) && s.marketCapUsd > 0)
      .reverse()
      .map((s) => ({ t: s.takenAt.getTime(), usd: s.marketCapUsd, buys: s.buys5m, sells: s.sells5m })),
    ...flagged,
  };
}

const weekLabels = new SharedCache<DayLabelRow[]>(TRACK_CACHE_MS);

/** TokenSage's read of one mint, as the token modal shows it (GET /tokens/:mint/sage). */
export async function readTokenSage(mintAddress: string): Promise<SageView> {
  const [row, token] = await Promise.all([
    prisma.tokenNarrative.findUnique({
      where: { mintAddress },
      select: {
        depth: true,
        status: true,
        failReason: true,
        categories: true,
        mainCategory: true,
        analysis: true,
      },
    }),
    prisma.token.findUnique({
      where: { mintAddress },
      select: { id: true, symbol: true, name: true, imageUrl: true, firstSeenAt: true },
    }),
  ]);
  const [snapshots, labels, judged] = await Promise.all([
    token
      ? prisma.tokenSnapshot.findMany({
          where: { tokenId: token.id },
          orderBy: { takenAt: "desc" },
          take: SAGE_CHART_POINTS,
          select: { takenAt: true, marketCapUsd: true },
        })
      : [],
    row?.categories
      ? weekLabels.get(() =>
          prisma.lighthouseDayLabel.findMany({
            where: {
              dimension: "category",
              day: { gte: new Date(Date.now() - TRACK_DAYS * 86_400_000) },
            },
            select: { day: true, label: true, count: true, alerts: true, graded: true, won2x: true },
          }),
        )
      : [],
    // The Narrative seat's judgments of this coin: its own calls and the notes it left on
    // other seats' cards. A coin carries a handful of cards at most.
    token
      ? prisma.curatedAlert.findMany({
          where: {
            tokenId: token.id,
            narrativeRationale: { not: Prisma.DbNull },
            OR: [{ model: NARRATIVE_CONTESTANT }, { narrativeVerdict: { not: null } }],
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            model: true,
            createdAt: true,
            narrativeVerdict: true,
            narrativeNotedAt: true,
            narrativeRationale: true,
          },
        })
      : ([] as NarrativeAlertRow[]),
  ]);
  const read =
    row?.status === "failed"
      ? null
      : sageRead(row?.analysis as TokenSageAnalysis | null, row?.depth ?? "basic");
  return {
    mint: mintAddress,
    token: token
      ? {
          symbol: token.symbol,
          name: token.name,
          imageUrl: token.imageUrl,
          firstSeenAt: token.firstSeenAt.toISOString(),
        }
      : null,
    status: read
      ? "ok"
      : row?.status === "failed"
        ? "failed"
        : row && row.analysis === null
          ? "expired"
          : "none",
    failReason: row?.status === "failed" ? failCode(row.failReason) : null,
    read,
    marketCap: snapshots
      .filter((s) => Number.isFinite(s.marketCapUsd) && s.marketCapUsd > 0)
      .reverse()
      .map((s) => ({ t: s.takenAt.toISOString(), usd: s.marketCapUsd })),
    track: read ? sageTrack(labels, row?.categories, row?.mainCategory) : null,
    narrative: sageNarrative(judged),
  };
}

/**
 * The code part of a stored TokenSage failure ("not_found: <upstream message>" -> "not_found").
 * The rest is TokenSage's own text, which can carry upstream detail no subscriber needs to see.
 */
export function failCode(reason: string | null): string | null {
  if (reason === null) return null;
  const colon = reason.indexOf(":");
  return (colon === -1 ? reason : reason.slice(0, colon)).trim() || null;
}
