import { contestantSpec, parseTextScores, prisma, type TextScores } from "@trenchscanner/core";
import { callPeakPct, creatorFeesByMint, type CardCreatorFee } from "./curatedFeed.js";
import { currentMarketCap } from "./routes/matches.js";

/**
 * One Model Alert, as the websocket sends it.
 *
 * The public card (mint, name, symbol, image, caps, confidence, tier, reasons, fees, links,
 * safety percents) plus the model that called it and the stored model scores. Narrative notes
 * (CuratedAlert.narrativeRationale) and other holders' wallets (linked holder lists, flagged
 * trade wallets, cluster dumps) are not on this object. Filter matches are not sent here at all.
 */
export interface ModelAlertMessage {
  kind: "curated";
  id: string;
  alertedAt: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  caps: {
    /** The call's anchor market cap, which Peak and the verdict count from. */
    alertMcapUsd: number;
    /** Pump.fun's cap as the call went out, when it answered. */
    liveMcapUsd: number | null;
    /** The newer of the live ping and the alert snapshot. */
    currentMcapUsd: number | null;
    /** The call's Peak as a market cap. Null until it traded above the alert. */
    peakMcapUsd: number | null;
    priceUsd: number;
  };
  confidence: number;
  tier: string | null;
  calibratedPct: number | null;
  reasons: string[];
  model: string | null;
  modelName: string | null;
  /** This call's model. One notification is one model's call. */
  models: {
    model: string | null;
    modelName: string | null;
    confidence: number;
    tier: string | null;
    calibratedPct: number | null;
  }[];
  /** Claude's text scores for the launch, when the worker has stored them. */
  aiTextScores: TextScores | null;
  links: {
    twitter: string | null;
    website: string | null;
    hasTelegram: boolean;
    pumpfun: string;
    dexscreener: string;
    axiom: string;
    gmgn: string;
    padre: string;
  };
  fees: {
    destination: string | null;
    summary: string | null;
    bps: number | null;
    charityName: string | null;
    deskLine: string | null;
    deskRewards: { label: string; mint: string | null }[] | null;
  } | null;
  safety: {
    top10HolderPct: number | null;
    largestHolderPct: number | null;
    devWalletPct: number | null;
    freshTop10WalletPct: number | null;
    emptyTop10WalletPct: number | null;
    sniperTop10WalletPct: number | null;
    linkedWalletPct: number | null;
    bundledSupplyPct: number | null;
    transferredSupplyPct: number | null;
    kolBundledPct: number | null;
    cexFundedPct: number | null;
    sameTimeFundedPct: number | null;
    rugScreenPassed: boolean | null;
    mintAuthorityActive: boolean | null;
    freezeAuthorityActive: boolean | null;
    lpBurned: boolean | null;
  };
}

/** True when the alert was written at or after the socket opened. Older rows are not a backlog. */
export function modelAlertArrivedAfterConnect(alertedAt: Date, openedAtMs: number): boolean {
  return alertedAt.getTime() >= openedAtMs;
}

const alertSelect = {
  id: true,
  createdAt: true,
  model: true,
  modelName: true,
  confidence: true,
  tier: true,
  calibratedPct: true,
  reasons: true,
  anchorPriceUsd: true,
  anchorMcapUsd: true,
  liveMcapUsd: true,
  peakMcapUsd: true,
  peak24hReturnPct: true,
  peakCheckedAt: true,
  token: {
    select: {
      mintAddress: true,
      name: true,
      symbol: true,
      imageUrl: true,
      twitterUrl: true,
      websiteUrl: true,
      hasTelegram: true,
      liveMarketCapUsd: true,
      liveDataAt: true,
      aiTextScores: true,
    },
  },
  snapshot: {
    select: {
      takenAt: true,
      marketCapUsd: true,
      top10HolderPct: true,
      largestHolderPct: true,
      devWalletPct: true,
      freshTop10WalletPct: true,
      emptyTop10WalletPct: true,
      sniperTop10WalletPct: true,
      linkedWalletPct: true,
      bundledSupplyPct: true,
      transferredSupplyPct: true,
      kolBundledPct: true,
      cexFundedPct: true,
      sameTimeFundedPct: true,
      rugScreenPassed: true,
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      lpBurned: true,
    },
  },
} as const;

type AlertRow = NonNullable<Awaited<ReturnType<typeof readAlert>>>;

async function readAlert(alertId: string) {
  return prisma.curatedAlert.findUnique({ where: { id: alertId }, select: alertSelect });
}

function modelNameOf(model: string | null, stored: string | null): string | null {
  if (stored) return stored;
  if (!model) return null;
  return contestantSpec(model)?.name ?? model;
}

function safetyOf(snapshot: AlertRow["snapshot"]): ModelAlertMessage["safety"] {
  return {
    top10HolderPct: snapshot?.top10HolderPct ?? null,
    largestHolderPct: snapshot?.largestHolderPct ?? null,
    devWalletPct: snapshot?.devWalletPct ?? null,
    freshTop10WalletPct: snapshot?.freshTop10WalletPct ?? null,
    emptyTop10WalletPct: snapshot?.emptyTop10WalletPct ?? null,
    sniperTop10WalletPct: snapshot?.sniperTop10WalletPct ?? null,
    linkedWalletPct: snapshot?.linkedWalletPct ?? null,
    bundledSupplyPct: snapshot?.bundledSupplyPct ?? null,
    transferredSupplyPct: snapshot?.transferredSupplyPct ?? null,
    kolBundledPct: snapshot?.kolBundledPct ?? null,
    cexFundedPct: snapshot?.cexFundedPct ?? null,
    sameTimeFundedPct: snapshot?.sameTimeFundedPct ?? null,
    rugScreenPassed: snapshot?.rugScreenPassed ?? null,
    mintAuthorityActive: snapshot?.mintAuthorityActive ?? null,
    freezeAuthorityActive: snapshot?.freezeAuthorityActive ?? null,
    lpBurned: snapshot?.lpBurned ?? null,
  };
}

function feesOf(fee: CardCreatorFee | null): ModelAlertMessage["fees"] {
  if (!fee) return null;
  return {
    destination: fee.destination,
    summary: fee.summary,
    bps: fee.bps,
    charityName: fee.charityName ?? null,
    deskLine: fee.deskLine ?? null,
    deskRewards: fee.deskRewards ?? null,
  };
}

/** Builds the websocket JSON from a loaded alert. Only the fields above are copied. */
export function toModelAlertMessage(alert: AlertRow, fee: CardCreatorFee | null): ModelAlertMessage {
  const mint = alert.token.mintAddress;
  const name = modelNameOf(alert.model, alert.modelName);
  const current = currentMarketCap(alert.token, alert.snapshot);
  const peakPct = callPeakPct(alert.peak24hReturnPct, alert);
  const peakMcapUsd = peakPct !== null && peakPct > 0 ? alert.anchorMcapUsd * (1 + peakPct / 100) : null;
  const call = {
    model: alert.model,
    modelName: name,
    confidence: alert.confidence,
    tier: alert.tier,
    calibratedPct: alert.calibratedPct,
  };
  return {
    kind: "curated",
    id: alert.id,
    alertedAt: alert.createdAt.toISOString(),
    mint,
    name: alert.token.name,
    symbol: alert.token.symbol,
    image: alert.token.imageUrl,
    caps: {
      alertMcapUsd: alert.anchorMcapUsd,
      liveMcapUsd: alert.liveMcapUsd,
      currentMcapUsd: current.marketCapUsd,
      peakMcapUsd,
      priceUsd: alert.anchorPriceUsd,
    },
    confidence: alert.confidence,
    tier: alert.tier,
    calibratedPct: alert.calibratedPct,
    reasons: alert.reasons.filter((reason) => !reason.startsWith("AI: ")),
    model: alert.model,
    modelName: name,
    models: [call],
    aiTextScores: parseTextScores(alert.token.aiTextScores),
    links: {
      twitter: alert.token.twitterUrl,
      website: alert.token.websiteUrl,
      hasTelegram: alert.token.hasTelegram,
      pumpfun: `https://pump.fun/coin/${mint}`,
      dexscreener: `https://dexscreener.com/solana/${mint}`,
      axiom: `https://axiom.trade/t/${mint}`,
      gmgn: `https://gmgn.ai/sol/token/${mint}`,
      padre: `https://trade.padre.gg/trade/solana/${mint}`,
    },
    fees: feesOf(fee),
    safety: safetyOf(alert.snapshot),
  };
}

export interface LoadedModelAlert {
  alertedAt: Date;
  message: ModelAlertMessage;
}

/** Loads one curated alert for the socket. Missing rows (and every filter match id) are null. */
export async function loadModelAlert(alertId: string): Promise<LoadedModelAlert | null> {
  const alert = await readAlert(alertId);
  if (!alert) return null;
  const fees = await creatorFeesByMint([alert.token.mintAddress]);
  return {
    alertedAt: alert.createdAt,
    message: toModelAlertMessage(alert, fees.get(alert.token.mintAddress) ?? null),
  };
}
