import type { WalletIdentityReader } from "./walletIdentity.js";
import {
  prisma,
  isHotFunder,
  LAUNCH_SNIPER,
  KNOWN_EXCHANGE_WALLETS,
  RISKY_WALLET_SCORE,
  SAME_TIME_FUNDING_MS,
  type HeliusClient,
  type WalletOverviewResult,
} from "@trenchscanner/core";

/**
 * The wallet modal's data (GET /wallets/:wallet, routes/wallets.ts): everything TrenchScanner
 * knows about one wallet, from its own tables, plus a live read of the chain for its balance and
 * history (WalletLiveReader). Built only when someone opens a wallet, so nothing here runs on the
 * scan's clock.
 *
 * What comes from where:
 * - Risk score and its counts: WalletRisk (rebuilt hourly from the trade tape).
 * - First funder: WalletFunder (the linked-wallets read); read live and cached there when missing.
 * - Age: the chain's first transaction when its history fits one signatures page, else the
 *   freshness check's WalletActivityCache, else the funding transfer's time.
 * - Linked cluster: the other wallets its funder paid for, and the wallets it paid for itself.
 * - Trades and PnL: TokenWalletActivity, one row per tracked coin whose trade tape was read.
 *   PnL is realised SOL only (out minus in); tokens still held are not valued.
 * - Dev launches: the tracked coins whose tape names it the creator.
 * - Labels: TrenchScanner's own (exchange hot wallets, scores, roles) - see walletLabels - then
 *   Helius's name and tags for it (walletIdentity.ts), and Solana Tracker's KOL roster (KolWallet,
 *   read daily by the worker's kol-wallets job).
 */

/** Coins listed per wallet: the newest ones. */
const MAX_COINS = 60;
/** Trades listed, newest first, across those coins. */
const MAX_TRADES = 40;
/** Linked wallets listed per side (same funder, funded by it). */
const MAX_LINKED = 24;
/** Funder statuses that are final answers (see FunderResult in core's helius.ts). */
const FINAL_FUNDER = new Set(["found", "none", "empty"]);

export type LabelTone = "dev" | "risky" | "linked" | "info" | "good";

export interface WalletLabel {
  text: string;
  tone: LabelTone;
  /** Where the label comes from, shown on hover. */
  source: string;
  detail?: string;
}

export interface WalletCoin {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  /** When the tape was read; the coin's call time when it was called. */
  at: string;
  reason: string | null;
  outcome: "win" | "stop" | "fizzle" | null;
  peakPct: number | null;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  /** solOut - solIn: realised only. */
  netSol: number;
  boughtPct: number | null;
  heldPct: number | null;
  firstBuyAt: string | null;
  roles: string[];
  isCreator: boolean;
}

export interface WalletTrade {
  at: number;
  side: "buy" | "sell";
  sol: number | null;
  mint: string;
  symbol: string | null;
}

export interface LinkedWallet {
  wallet: string;
  /**
   * "sibling": its funder paid for this one too. "funded": this wallet paid for it. "same-minute":
   * funded within a minute of this one, by any funder (core's SAME_TIME_FUNDING_MS).
   */
  relation: "sibling" | "funded" | "same-minute";
  amountSol: number | null;
  fundedAt: string | null;
  score: number | null;
}

export interface WalletProfile {
  wallet: string;
  labels: WalletLabel[];
  /** On Solana Tracker's KOL roster: its name and X handle. */
  kol: {
    name: string | null;
    twitter: string | null;
    realizedPnlUsd: number | null;
    winRate: number | null;
  } | null;
  live: {
    readAt: string;
    balanceSol: number | null;
    txCount: number;
    /** False when the history is longer than one page: txCount is then a floor. */
    complete: boolean;
    lastAt: string | null;
  } | null;
  /** First seen on chain, from whichever source knew (see the file comment). */
  firstSeenAt: string | null;
  /** Whether firstSeenAt is a floor ("older than") rather than the first transaction. */
  firstSeenIsFloor: boolean;
  funder: {
    status: string;
    wallet: string | null;
    amountSol: number | null;
    fundedAt: string | null;
    /** The funder's own label: an exchange or a busy service, which links nothing. */
    label: string | null;
  } | null;
  /** USD in tokens other than SOL and stablecoins, at the last holdings check; a floor. */
  otherHoldingsUsd: number | null;
  otherHoldingsAt: string | null;
  risk: {
    score: number;
    coins: number;
    dumps: number;
    fastExits: number;
    snipes: number;
    /** The win side (walletWinScore): coins it bought that doubled, those it was in before the call, and the 0-100 score. */
    wins: number;
    earlyWins: number;
    winScore: number;
    /** The labels the book decided: at most one of dumper and winner. */
    dumper: boolean;
    winner: boolean;
    sniper: boolean;
    medianSupplyPct: number | null;
    lastSeenAt: string;
    computedAt: string;
  } | null;
  totals: {
    coins: number;
    wins: number;
    solIn: number;
    solOut: number;
    netSol: number;
    /** Coins where it took out more SOL than it put in. */
    profitable: number;
  };
  coins: WalletCoin[];
  trades: WalletTrade[];
  launches: WalletCoin[];
  linked: LinkedWallet[];
}

interface RiskRow {
  score: number;
  appearances: number;
  dumps: number;
  fastExits: number;
  snipes: number;
  wins: number;
  /** The count-and-rate labels the wallet book decided (walletLabels in core). */
  dumper: boolean;
  winner: boolean;
  sniper: boolean;
  medianSupplyPct: number | null;
  lastSeenAt: Date;
  computedAt: Date;
}

/** The labels TrenchScanner can put on a wallet from what it already knows. Exported for tests. */
export function walletLabels(input: {
  wallet: string;
  risk: RiskRow | null;
  funderHot: boolean;
  funderWallet: string | null;
  launches: number;
  snipes: number;
  live: Extract<WalletOverviewResult, { status: "found" }> | null;
  fundedCount: number;
}): WalletLabel[] {
  const out: WalletLabel[] = [];
  const exchange = KNOWN_EXCHANGE_WALLETS.get(input.wallet);
  if (exchange)
    out.push({ text: `${exchange} hot wallet`, tone: "info", source: "TrenchScanner exchange list" });
  if (input.launches > 0)
    out.push({
      text: input.launches === 1 ? "Dev" : `Dev of ${input.launches} coins`,
      tone: "dev",
      source: "TrenchScanner trade tapes",
      detail: "Created coins TrenchScanner tracked",
    });
  const r = input.risk;
  if (r && r.score >= RISKY_WALLET_SCORE)
    out.push({
      text: "Risky",
      tone: "risky",
      source: "TrenchScanner risk score",
      detail: `Scored ${Math.round(r.score)} of 100 from ${r.appearances} coins`,
    });
  if (r?.dumper)
    out.push({
      text: "Known dumper",
      tone: "risky",
      source: "TrenchScanner risk score",
      detail: `Sold into the stop on ${r.dumps} of the ${r.appearances} called coins it bought`,
    });
  if (r?.winner)
    out.push({
      text: "Winner",
      tone: "good",
      source: "TrenchScanner win score",
      detail: `${r.wins} of the ${r.appearances} called coins it bought doubled`,
    });
  // The book decides the sniper label with its rate rule; a wallet with no book row has fewer
  // than two coins read, so the count alone can't reach the bar.
  if (r ? r.sniper : input.snipes >= LAUNCH_SNIPER.minSnipes)
    out.push({
      text: "Launch sniper",
      tone: "risky",
      source: "TrenchScanner trade tapes",
      detail: `Bought ${input.snipes} tracked coins in their first 5 seconds`,
    });
  if (input.funderWallet && input.funderHot) {
    const name = KNOWN_EXCHANGE_WALLETS.get(input.funderWallet);
    out.push({
      text: name ? `Funded from ${name}` : "Funded from an exchange or service",
      tone: "info",
      source: "TrenchScanner funder read",
    });
  }
  if (input.fundedCount >= 3)
    out.push({
      text: `Funded ${input.fundedCount} wallets`,
      tone: "linked",
      source: "TrenchScanner funder read",
      detail: "Paid for wallets TrenchScanner saw as holders",
    });
  if (input.live && input.live.complete && input.live.firstAt) {
    const ageMs = Date.now() - input.live.firstAt.getTime();
    if (ageMs < 24 * 3_600_000)
      out.push({
        text: "Fresh wallet",
        tone: "risky",
        source: "Chain",
        detail: "First used in the last day",
      });
  }
  if (input.live && !input.live.complete)
    out.push({ text: "Very active", tone: "info", source: "Chain", detail: "1,000+ transactions" });
  return out;
}

const roleList = (a: {
  isCreator: boolean;
  firstBuyerRank: number | null;
  launchSniper: boolean;
  top10AtAnchor: boolean;
  fastExit: boolean;
  dumpedIntoStop: boolean;
}) =>
  [
    a.isCreator && "dev",
    a.launchSniper && "sniper",
    a.firstBuyerRank !== null && `buyer #${a.firstBuyerRank}`,
    a.top10AtAnchor && "top 10",
    a.fastExit && "fast exit",
    a.dumpedIntoStop && "sold into stop",
  ].filter((r): r is string => typeof r === "string");

/** A stored trade ([ms, 1 | -1, SOL, tokens], core's StoredTrade) as a WalletTrade; null when malformed. */
function tradeOf(raw: unknown, mint: string, symbol: string | null): WalletTrade | null {
  if (!Array.isArray(raw)) return null;
  const [at, side, sol] = raw as unknown[];
  if (typeof at !== "number" || !Number.isFinite(at) || (side !== 1 && side !== -1)) return null;
  return {
    at,
    side: side === 1 ? "buy" : "sell",
    sol: typeof sol === "number" && Number.isFinite(sol) ? sol : null,
    mint,
    symbol,
  };
}

/** The newest trades across a wallet's coins. Exported for tests. */
export function recentTrades(
  rows: { mint: string; symbol: string | null; trades: unknown }[],
  limit = MAX_TRADES,
): WalletTrade[] {
  const out: WalletTrade[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.trades)) continue;
    for (const t of r.trades) {
      const trade = tradeOf(t, r.mint, r.symbol);
      if (trade) out.push(trade);
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Reads the chain for the modal, at most once per wallet per TTL and at most `perMinute` wallets a
 * minute across everyone, so a busy dashboard can't run up the Helius bill. Past the cap a wallet
 * opens without its live read rather than waiting.
 */
export class WalletLiveReader {
  private cache = new Map<string, { at: number; value: Promise<WalletOverviewResult> }>();
  private window: number[] = [];

  constructor(
    private readonly helius: Pick<HeliusClient, "getWalletOverview" | "getFundersBatch">,
    private readonly opts: { ttlMs: number; perMinute: number; maxEntries?: number } = {
      ttlMs: 5 * 60_000,
      perMinute: 60,
    },
  ) {}

  /** Whether one more live read fits in this minute's budget; spends it when it does. */
  private spend(now: number): boolean {
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.opts.perMinute) return false;
    this.window.push(now);
    return true;
  }

  async overview(wallet: string, now = Date.now()): Promise<WalletOverviewResult | null> {
    const hit = this.cache.get(wallet);
    if (hit && now - hit.at < this.opts.ttlMs) return hit.value;
    if (!this.spend(now)) return null;
    const value = this.helius.getWalletOverview(wallet);
    if (this.cache.size >= (this.opts.maxEntries ?? 2_000)) this.cache.clear();
    this.cache.set(wallet, { at: now, value });
    const result = await value;
    // A failed read is not kept: the next open tries again.
    if (result.status === "failed") this.cache.delete(wallet);
    return result;
  }

  /** The wallet's funder, read live when the linked-wallets job hasn't; null over budget. */
  async funder(wallet: string, now = Date.now()) {
    if (!this.spend(now)) return null;
    return (await this.helius.getFundersBatch([wallet])).get(wallet) ?? null;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Everything the modal shows for one wallet. `live` null: no chain read (none configured, or over budget). */
export async function loadWalletProfile(
  wallet: string,
  live: WalletLiveReader | null,
  identity: WalletIdentityReader | null = null,
): Promise<WalletProfile> {
  const identityRead = identity ? identity.labels(wallet).catch(() => []) : Promise.resolve([]);
  const [risk, funderRow, activityCache, holdings, activity, fundedRows, overview, kol] = await Promise.all([
    prisma.walletRisk.findUnique({ where: { wallet } }),
    prisma.walletFunder.findUnique({ where: { wallet } }),
    prisma.walletActivityCache.findUnique({ where: { address: wallet } }),
    prisma.walletHoldingsCache.findUnique({ where: { address: wallet } }),
    prisma.tokenWalletActivity.findMany({
      where: { wallet },
      orderBy: { createdAt: "desc" },
      take: MAX_COINS,
      include: {
        token: {
          select: { mintAddress: true, symbol: true, name: true, imageUrl: true, tradeTape: true },
        },
      },
    }),
    prisma.walletFunder.findMany({
      where: { funder: wallet, status: "found" },
      orderBy: { fundedAt: "desc" },
      take: MAX_LINKED,
    }),
    live ? live.overview(wallet).catch(() => null) : Promise.resolve(null),
    prisma.kolWallet.findUnique({ where: { wallet } }),
  ]);

  // The funder, read now when the linked-wallets job never reached this wallet. Cached in the
  // same table it would have written, with the same rule: only final answers are kept.
  let funder: {
    status: string;
    funder: string | null;
    amountSol: number | null;
    fundedAt: Date | null;
  } | null = funderRow;
  if ((!funderRow || !FINAL_FUNDER.has(funderRow.status)) && live) {
    const read = await live.funder(wallet).catch(() => null);
    if (read && FINAL_FUNDER.has(read.status)) {
      const row = {
        wallet,
        status: read.status,
        funder: read.status === "found" ? read.funder : null,
        amountSol: read.status === "found" ? read.amountSol : null,
        fundedAt: read.status === "found" ? read.fundedAt : null,
      };
      await prisma.walletFunder
        .upsert({ where: { wallet }, create: row, update: { ...row, checkedAt: new Date() } })
        .catch(() => undefined);
      funder = row;
    }
  }

  const funderWallet = funder?.status === "found" ? funder.funder : null;
  const fundedAt = funder?.status === "found" ? funder.fundedAt : null;
  const [funderActivity, fundedLast24h, siblingRows, sameMinuteRows] = await Promise.all([
    funderWallet ? prisma.funderActivity.findUnique({ where: { address: funderWallet } }) : null,
    funderWallet
      ? prisma.walletFunder.count({
          where: {
            funder: funderWallet,
            status: "found",
            fundedAt: { gte: new Date(Date.now() - 86_400_000) },
          },
        })
      : 0,
    funderWallet
      ? prisma.walletFunder.findMany({
          where: { funder: funderWallet, status: "found", wallet: { not: wallet } },
          orderBy: { fundedAt: "desc" },
          take: MAX_LINKED,
        })
      : [],
    // Wallets funded within a minute of this one, whoever paid: a bundle is often paid for by
    // several wallets at one go (user ask 2026-10-13).
    fundedAt
      ? prisma.walletFunder.findMany({
          where: {
            status: "found",
            wallet: { not: wallet },
            fundedAt: {
              gte: new Date(fundedAt.getTime() - SAME_TIME_FUNDING_MS),
              lte: new Date(fundedAt.getTime() + SAME_TIME_FUNDING_MS),
            },
          },
          orderBy: { fundedAt: "asc" },
          take: MAX_LINKED,
        })
      : [],
  ]);
  const funderHot = funderWallet
    ? isHotFunder(funderWallet, {
        fullPageSpanMs: funderActivity?.fullPageSpanMs ?? null,
        fundedLast24h,
      }) || !!funderActivity?.hot
    : false;
  // An exchange paid for thousands of wallets: its other customers are not linked to this one.
  const siblings = funderHot ? [] : siblingRows;

  const outcomeIds = activity.map((a) => a.token.tradeTape?.outcomeId).filter((id): id is string => !!id);
  const related = new Set([...siblings.map((s) => s.wallet), ...fundedRows.map((f) => f.wallet)]);
  const sameMinute = sameMinuteRows.filter((r) => !related.has(r.wallet));
  const linkedWallets = [...related, ...sameMinute.map((r) => r.wallet)];
  const [outcomes, linkedScores] = await Promise.all([
    outcomeIds.length > 0
      ? prisma.candidateOutcome.findMany({
          where: { id: { in: outcomeIds } },
          select: { id: true, hit2xIn1h: true, disqualified: true, stoppedAt: true, peak1hReturnPct: true },
        })
      : [],
    linkedWallets.length > 0
      ? prisma.walletRisk.findMany({
          where: { wallet: { in: linkedWallets } },
          select: { wallet: true, score: true },
        })
      : [],
  ]);
  const outcomeById = new Map(outcomes.map((o) => [o.id, o]));
  const scoreOf = new Map(linkedScores.map((s) => [s.wallet, s.score]));

  const coins: WalletCoin[] = activity.map((a) => {
    const tape = a.token.tradeTape;
    const o = tape?.outcomeId ? outcomeById.get(tape.outcomeId) : undefined;
    return {
      mint: a.token.mintAddress,
      symbol: a.token.symbol,
      name: a.token.name,
      imageUrl: a.token.imageUrl,
      at: (tape?.anchorAt ?? a.createdAt).toISOString(),
      reason: tape?.reason ?? null,
      outcome: o ? (o.hit2xIn1h && !o.disqualified ? "win" : o.stoppedAt ? "stop" : "fizzle") : null,
      peakPct: o?.peak1hReturnPct ?? null,
      buys: a.buys,
      sells: a.sells,
      solIn: a.solIn,
      solOut: a.solOut,
      netSol: a.solOut - a.solIn,
      boughtPct: a.boughtPct,
      heldPct: a.heldPctAtAnchor,
      firstBuyAt: iso(a.firstBuyAt),
      roles: roleList(a),
      isCreator: a.isCreator,
    };
  });
  const launches = coins.filter((c) => c.isCreator);
  const traded = coins.filter((c) => c.solIn > 0 || c.solOut > 0);
  const sum = (f: (c: WalletCoin) => number) => traded.reduce((s, c) => s + f(c), 0);

  const liveFound = overview && overview.status === "found" ? overview : null;
  // Age: the chain's own first transaction when the page held all of it; else the freshness
  // check's answer; else the funding transfer, which is at least as old as the wallet's use.
  let firstSeenAt: Date | null = liveFound?.firstAt ?? activityCache?.earliestActivityAt ?? null;
  let firstSeenIsFloor = false;
  if (!firstSeenAt && funder?.fundedAt) firstSeenAt = funder.fundedAt;
  if (!liveFound?.firstAt && !activityCache?.earliestActivityAt && liveFound && !liveFound.complete) {
    firstSeenIsFloor = true;
  }

  const outside = await identityRead;
  const ownLabels = walletLabels({
    wallet,
    risk,
    funderHot,
    funderWallet,
    launches: launches.length,
    snipes: Math.max(risk?.snipes ?? 0, coins.filter((c) => c.roles.includes("sniper")).length),
    live: liveFound,
    fundedCount: fundedRows.length,
  });
  if (kol)
    ownLabels.unshift({
      text: kol.name ? `KOL: ${kol.name}` : "KOL",
      tone: "good",
      source: "Solana Tracker KOL list",
      detail: kol.twitter ? `@${kol.twitter} on X` : undefined,
    });
  const ownTexts = new Set(ownLabels.map((l) => l.text.toLowerCase()));

  return {
    wallet,
    labels: [...ownLabels, ...outside.filter((l) => !ownTexts.has(l.text.toLowerCase()))],
    kol: kol
      ? { name: kol.name, twitter: kol.twitter, realizedPnlUsd: kol.realizedPnlUsd, winRate: kol.winRate }
      : null,
    live: liveFound
      ? {
          readAt: new Date().toISOString(),
          balanceSol: liveFound.balanceSol,
          txCount: liveFound.txCount,
          complete: liveFound.complete,
          lastAt: iso(liveFound.lastAt),
        }
      : null,
    firstSeenAt: iso(firstSeenAt),
    firstSeenIsFloor,
    funder: funder
      ? {
          status: funder.status,
          wallet: funderWallet,
          amountSol: funder.amountSol,
          fundedAt: iso(funder.fundedAt),
          label: funderWallet
            ? (KNOWN_EXCHANGE_WALLETS.get(funderWallet) ?? (funderHot ? "Exchange or service" : null))
            : null,
        }
      : null,
    otherHoldingsUsd: holdings?.otherHoldingsUsd ?? null,
    otherHoldingsAt: iso(holdings?.checkedAt),
    risk: risk
      ? {
          score: risk.score,
          coins: risk.appearances,
          dumps: risk.dumps,
          fastExits: risk.fastExits,
          snipes: risk.snipes,
          wins: risk.wins,
          earlyWins: risk.earlyWins,
          winScore: risk.winScore,
          dumper: risk.dumper,
          winner: risk.winner,
          sniper: risk.sniper,
          medianSupplyPct: risk.medianSupplyPct,
          lastSeenAt: risk.lastSeenAt.toISOString(),
          computedAt: risk.computedAt.toISOString(),
        }
      : null,
    totals: {
      coins: traded.length,
      wins: traded.filter((c) => c.outcome === "win").length,
      solIn: sum((c) => c.solIn),
      solOut: sum((c) => c.solOut),
      netSol: sum((c) => c.netSol),
      profitable: traded.filter((c) => c.netSol > 0).length,
    },
    coins,
    trades: recentTrades(
      activity.map((a) => ({ mint: a.token.mintAddress, symbol: a.token.symbol, trades: a.trades })),
    ),
    launches,
    linked: [
      ...siblings.map((s): LinkedWallet => ({
        wallet: s.wallet,
        relation: "sibling",
        amountSol: s.amountSol,
        fundedAt: iso(s.fundedAt),
        score: scoreOf.get(s.wallet) ?? null,
      })),
      ...fundedRows.map((f): LinkedWallet => ({
        wallet: f.wallet,
        relation: "funded",
        amountSol: f.amountSol,
        fundedAt: iso(f.fundedAt),
        score: scoreOf.get(f.wallet) ?? null,
      })),
      ...sameMinute.map((r): LinkedWallet => ({
        wallet: r.wallet,
        relation: "same-minute",
        amountSol: r.amountSol,
        fundedAt: iso(r.fundedAt),
        score: scoreOf.get(r.wallet) ?? null,
      })),
    ],
  };
}
