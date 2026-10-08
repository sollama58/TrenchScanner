import { authHeaders } from "./session";

/**
 * The API client. Every call carries the session cookie (credentials: "include"): the API sets it
 * on sign-in and reads it on every request, and this page lives on a different origin from it.
 * Browsers that drop that cookie as third-party send the token as a header instead (session.ts).
 */

/**
 * Dashboard sites with an API on their own subdomain. A page on one of these (apex, www or any
 * other subdomain) calls that API instead of VITE_API_URL: same site, so the session cookie is a
 * first-party SameSite=Lax cookie that Safari, Brave and Edge's tracking prevention leave alone.
 * Every other host (trenchscanner-web.onrender.com, localhost) keeps VITE_API_URL. index.html's
 * boot prefetch repeats this table; keep the two in step.
 */
export const SAME_SITE_APIS: Readonly<Record<string, string>> = {
  "trenchscanner.app": "https://api.trenchscanner.app",
};

/** The API base for a page served from `hostname`, falling back to `configured`. */
export function apiUrlFor(hostname: string, configured: string | undefined): string {
  const host = hostname.toLowerCase();
  for (const [site, url] of Object.entries(SAME_SITE_APIS)) {
    if (host === site || host.endsWith(`.${site}`)) return url;
  }
  return configured?.replace(/\/$/, "") || "http://localhost:4000";
}

export const API_URL = apiUrlFor(
  typeof location === "undefined" ? "" : location.hostname,
  import.meta.env.VITE_API_URL as string | undefined,
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(new Headers(init.headers));
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return parse<T>(await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" }));
}

/** Reads an API response: the JSON body, or an ApiError for a non-2xx status. */
export async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Fetches a file the API serves (signed in like any call) and hands it to the browser to save. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const headers = authHeaders(new Headers());
  const res = await fetch(`${API_URL}${path}`, { headers, credentials: "include" });
  if (!res.ok) await parse(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- Shapes the API returns (only the fields this UI reads) ----

export interface User {
  id: string;
  walletAddress: string;
  isAdmin: boolean;
}

export interface Subscription {
  hasAccess: boolean;
  reason: "admin" | "whitelist" | "subscription" | "none" | null;
  expiresAt: string | null;
  /** What access costs, in $ASDFASDFA. */
  price?: { mint: string; decimals: number; tokensPerMonth: number; daysPerMonth: number };
}

export interface Token {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  graduated?: boolean | null;
  /** The last measured top-10 wallet shares, from any scan - for when the snapshots lack one. */
  lastEmptyTop10WalletPct?: number | null;
  lastFreshTop10WalletPct?: number | null;
  /** Where the coin's creator fee goes, from its TokenSage read; null when the read doesn't say. */
  creatorFee?: { destination: string; summary: string | null } | null;
}

export interface Snapshot {
  takenAt: string;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volumeToMcapRatio: number | null;
  buys24h: number | null;
  sells24h: number | null;
  holderCount: number | null;
  holderGrowthPct: number | null;
  top10HolderPct: number | null;
  devWalletPct: number | null;
  riskScore: number | null;
  freshTop10WalletPct: number | null;
  /** Share of the top 10 holders with under $25 of other tokens; null when not checked. */
  emptyTop10WalletPct?: number | null;
  /** Of the launch's first 25 buyers (firstBuyersSeen while fewer), how many still hold it. */
  firstBuyersHolding?: number | null;
  firstBuyersSeen?: number | null;
  /** Whether the dev still holds the token; null when unknown. */
  devHolding?: boolean | null;
  ageMinutes: number | null;
  graduated: boolean | null;
  /** The token's composite score (0-100) at this scan; null on a model card's stand-in snapshot. */
  score: number | null;
  /** Trading volume over the last 5 minutes and hour, as the scan saw it. */
  volume5mUsd?: number | null;
  volume1hUsd?: number | null;
}

export type OutcomeStatus = "watching" | "won" | "missed" | "disqualified" | "unknown";

export interface Outcome {
  status: OutcomeStatus;
  hit2x: boolean;
  hitGoal: boolean | null;
  /** Reached 10x within an hour, before the stop; null until known (absent from older API builds). */
  hitTenX?: boolean | null;
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  /** The run peak: winners stay watched for a day to see how high they go. */
  peak24hReturnPct: number | null;
  /** Minutes from the alert to the run peak (older API builds omit it). */
  runPeakMinutes?: number | null;
  finalized: boolean;
  minutesLeft: number | null;
}

export interface AdminAiReview {
  mode: string;
  decision: string | null;
  probability2x: number | null;
  probability4x: number | null;
  reasoning: string | null;
  risks: string[];
  error: string | null;
}

export interface CuratedMeta {
  alertId: string;
  source: string;
  /** The contestant whose call this is, and its display name (null on pre-contest rows). */
  model?: string | null;
  modelName?: string | null;
  confidence: number;
  /** "high" for a high-conviction call (the model's top half-percent of moments), "standard" otherwise; null on rules calls and older rows. */
  tier?: string | null;
  /** The 2x rate of recent out-of-sample calls ranked like this one, in percent, at emission. */
  calibratedPct?: number | null;
  reasons: string[];
  alertedAt: string;
  outcome: Outcome;
  /** The call's Peak, which only rises: its run peak or its market-cap high since (absent from older API builds). */
  peakPct?: number | null;
  /** The Narrative seat's later view of the call, once the deep read decided; null until then. */
  narrative?: { verdict: "agrees" | "warns"; at: string } | null;
  aiReview?: AdminAiReview;
  /** On the combined feed: every model that called this token, first call first. */
  calledBy?: ModelCall[];
}

export interface ModelCall {
  model: string | null;
  modelName: string | null;
  confidence: number;
  tier?: string | null;
  calibratedPct?: number | null;
  alertedAt: string;
}

/** GET /live/market: current market data for the tokens on screen, seconds old. */
export interface LiveMarket {
  at: string;
  tokens: { id: string; marketCapUsd: number; priceUsd: number | null; at: string }[];
}

/** One feed card - a filter match or a curated alert, which the API serializes alike. */
export interface Card {
  id: string;
  kind: "match" | "curated";
  tokenId: string;
  matchedAt: string;
  score: number;
  peakReturnPct: number | null;
  token: Token;
  snapshot: Snapshot;
  latestSnapshot: Snapshot | null;
  currentMarketCapUsd: number | null;
  /** When currentMarketCapUsd was read (absent from API builds before the live tick). */
  currentMarketCapAt?: string | null;
  filter: { id: string; name: string } | null;
  curated: CuratedMeta | null;
  /**
   * A filter alert's outcome from its open grading row, so a 2x shows the moment it lands (API
   * builds before it only send the columns below, written when the window closes).
   */
  outcome?: Outcome | null;
  // Match-only outcome columns.
  hit2xIn1h?: boolean | null;
  hit4xIn1h?: boolean | null;
  hit10xIn1h?: boolean | null;
  disqualified?: boolean | null;
}

export interface CuratedPage {
  alerts: Card[];
  page: number;
  pageSize: number;
  totalCount: number;
  /** Whose calls these are. */
  model: { id: string; name: string; isDefault: boolean };
}

/** GET /matches/stats: how the coins this reader's own feed alerted on did over the window. */
export interface FeedStats {
  hours: number;
  alerts: number;
  fromFilter: number;
  fromModels: number;
  graded: number;
  pending: number;
  hit2x: number;
  hit2xPct: number | null;
  goalGraded: number;
  hit4x: number;
  hit4xPct: number | null;
  /** The 10x-within-an-hour tier (absent from older API builds). */
  tenXGraded?: number;
  hit10x?: number;
  hit10xPct?: number | null;
  best: { tokenId: string; symbol: string | null; peakPct: number } | null;
  medianPeakPct: number | null;
  showModelAlerts: boolean;
  truncated: boolean;
}

/** GET /matches/returns: the average exit-plan return of the reader's feed over 1h, 6h, 24h and 7d. */
export interface FeedReturns {
  windows: {
    hours: number;
    alerts: number;
    settled: number;
    avgReturnPct: number | null;
    profitable: number;
    bucketMinutes: number;
    buckets: { at: string; settled: number; avgReturnPct: number | null }[];
  }[];
  /** The week's three biggest runs (the cards' Peak), one per token, best first (absent from older API builds). */
  top?: {
    tokenId: string;
    symbol: string | null;
    name: string | null;
    mintAddress: string;
    at: string;
    /** The card's Peak: the highest the token went above its alert price, in percent. */
    peakPct: number;
    /** What alerted it (absent from older API builds; null when the filter has been deleted). */
    source?: { kind: "filter" | "model"; name: string } | null;
  }[];
  /** The same, from the followed models' calls alone and the reader's own filters' alerts alone (absent from older API builds). */
  topBySource?: { model: NonNullable<FeedReturns["top"]>; filter: NonNullable<FeedReturns["top"]> };
  showModelAlerts: boolean;
  truncated: boolean;
}

export interface MatchPage {
  matches: Card[];
  page: number;
  pageSize: number;
  totalCount: number;
  /** Whether an older page has anything on it (the combined feed pages on this, not totalCount). */
  hasMore?: boolean;
}

export interface CuratedStats {
  curator: { active: string; phase: string; modelTrainedAt: string | null };
  training: { finalizedSamples: number; samples7d: number; winners: number; baseWinRatePct: number | null };
  feed: {
    alertsTotal: number;
    alerts7d: number;
    pace: { targetPerHour: number; alerts24h: number; actualPerHour24h: number };
    graded: number;
    wins: number;
    hitRatePct: number | null;
    goalHits: number;
    goalRatePct: number | null;
    tenXHits?: number;
    tenXGraded?: number;
    tenXRatePct?: number | null;
    bestPeak24hReturnPct: number | null;
  };
  /** Absent from older API builds mid-deploy, null when the reading failed. */
  market?: MarketWeather | null;
}

/** How often launches are doubling now against the last week. Informational; gates nothing. */
export interface MarketWeather {
  condition: "hot" | "normal" | "cold" | "unknown";
  recentHours: number;
  recentGraded: number;
  recentWins: number;
  recentRatePct: number | null;
  trailingDays: number;
  trailingGraded: number;
  trailingWins: number;
  trailingRatePct: number | null;
  ratio: number | null;
}

export interface GradedRates {
  calls: number;
  graded: number;
  won2x: number;
  won4x: number;
  doubledAfterStop: number;
  pending: number;
  hitRate2xPct: number | null;
  hitRate4xPct: number | null;
  /** 10x within an hour (absent from older API builds and from sources that don't read it). */
  won10x?: number;
  /** Calls whose 10x tier has settled - the 10x rate's denominator. */
  tenXGraded?: number;
  hitRate10xPct?: number | null;
  /** Average / total simulated return under the fixed exit plan, in percent (absent from older API builds). */
  avgSimReturnPct?: number | null;
  totalSimReturnPct?: number | null;
  simCalls?: number;
  verdict: "meets-targets" | "below-targets" | "insufficient-data";
}

export interface CurvePoint {
  minProbability: number;
  alerts: number;
  winRatePct: number;
  goalRatePct: number;
}

export interface Calibration {
  threshold: number | null;
  meetsTargets?: boolean;
  support: number;
  winRatePct: number | null;
  goalRatePct: number | null;
}

export interface ModelRun {
  id: string;
  contestant: string | null;
  contestantName: string | null;
  createdAt: string;
  kind: string;
  learner: "logistic" | "gbdt" | "forest";
  status: string;
  trainingRows: number;
  trainingFrom: string;
  trainingTo: string;
  activatedAt: string | null;
  verdict: { promote: boolean; reason: string } | null;
  familyComparison: {
    learner: "logistic" | "gbdt" | "forest";
    verdict: { promote: boolean; reason: string };
    precisionCalibration: Calibration;
  }[];
  precisionCalibration: Calibration | null;
  precisionCurve: CurvePoint[];
  heuristicCalibration: Calibration | null;
  heuristicPrecisionCurve: CurvePoint[];
  folds: {
    testFrom: string;
    testTo: string;
    testRows: number;
    baseWinRatePct: number;
    model: { emitted: number; precisionPct: number | null; goalPrecisionPct: number | null };
    heuristic: { emitted: number; precisionPct: number | null; goalPrecisionPct: number | null };
  }[];
}

export interface AiReviewRow {
  id: string;
  createdAt: string;
  mode: string;
  decision: "buy" | "no_buy" | "error";
  probability2x: number | null;
  probability4x: number | null;
  anchorMcapUsd: number;
  alerted: boolean;
  token: { mintAddress: string; symbol: string | null; name: string | null; imageUrl: string | null };
  outcome: "pending" | "won" | "won4x" | "won10x" | "missed" | "stopped" | "unknown";
  reasoning?: string | null;
  risks?: string[];
  error?: string | null;
}

/** A playbook's (or a replay's) record - curation/aiJudge.ts JudgeRecordSummary. */
export interface JudgeRecordSummary {
  reviewed: number;
  buys: number;
  buyWinRatePct: number | null;
  buyGoalRatePct: number | null;
  baseWinRatePct: number | null;
  baseGoalRatePct: number | null;
  liftPts: number | null;
  missedWinnersPct: number | null;
  brier: number | null;
  curatorBrier: number | null;
  score: number | null;
}

export interface AiJudgeState {
  playbooks: {
    id: string;
    version: number;
    status: "active" | "candidate" | "retired" | "rejected";
    createdAt: string;
    decidedAt: string | null;
    metrics: JudgeRecordSummary | null;
    text?: string;
    rationale?: string | null;
  }[];
  replays: {
    id: string;
    purpose: "baseline" | "evolution";
    status: "submitted" | "scored" | "failed";
    createdAt: string;
    scoredAt: string | null;
    requestCount: number;
    playbookVersions: (number | null)[];
    error?: string | null;
  }[];
  blend: {
    createdAt: string;
    usable: boolean;
    metrics: {
      rows: number;
      brierBlend: number | null;
      brierCurator: number | null;
      brierAi: number | null;
      baseWinRatePct: number | null;
      keptRows: number;
      keptWinRatePct: number | null;
      keptGoalRatePct: number | null;
      reason: string;
    };
  } | null;
}

export interface LearningRates {
  calls: number;
  graded: number;
  won2x: number;
  won4x: number;
  doubledAfterStop: number;
  rate2xPct: number | null;
  rate4xPct: number | null;
  /** 10x within an hour over the calls whose tier has settled (absent from older API builds). */
  won10x?: number;
  tenXGraded?: number;
  rate10xPct?: number | null;
}

export interface LearningDay {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  /** The decision moments the models saw that day (graded "event" training rows). */
  market: LearningRates;
  /** Every model's calls that day, pooled. */
  feed: LearningRates;
  /** feed 2x rate / market 2x rate; null when either side is too thin. */
  lift2x: number | null;
  lift4x: number | null;
  lift10x?: number | null;
}

export interface LearningRunModel {
  contestant: string;
  name: string | null;
  calls: number;
  wins: number;
  goals: number;
  tenX?: number | null;
  rate2xPct: number | null;
  rate4xPct: number | null;
  rate10xPct?: number | null;
  lift2x: number | null;
  score: number | null;
}

export interface LearningRun {
  at: string;
  trainingRows: number;
  historyDays: number;
  exam: { decisionRows: number; decisionWins: number; baseRate2xPct: number | null };
  models: LearningRunModel[];
  best: LearningRunModel | null;
}

export interface LearningSpan {
  from: string;
  to: string;
  feed: LearningRates;
  market: LearningRates;
  lift2x: number | null;
}

export interface LearningTrend {
  recent: LearningSpan;
  prior: LearningSpan | null;
  verdict: "improving" | "flat" | "worsening" | "too-early";
  reason: string;
}

/** Day-over-day: the feed's edge over the market, and each training run's exam against its base rate. */
export interface LearningCurve {
  window: { since: string; until: string };
  days: LearningDay[];
  runs: LearningRun[];
  trend: LearningTrend | null;
  minGradedForLift: number;
  trendSpanDays: number;
  note: string;
}

export interface ModelInsights {
  window: { days: number };
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  rules: { win: string; goal: string; fill: string };
  minGradedForVerdict: number;
  curator: {
    active: string;
    phase: "model-live" | "heuristic-live";
    aiReviewMode: "off" | "shadow" | "gate";
    aiReviewMinGradedBuys: number;
    targetPerHour: number;
  };
  importance: {
    modelId: string;
    learner: "logistic" | "gbdt" | "forest";
    threshold: number;
    features: { feature: string; label: string; sharePct: number; direction: 1 | -1 | null }[];
  } | null;
  runs: ModelRun[];
  learning: LearningCurve;
  curatedAlerts: {
    total: GradedRates;
    bySource: (GradedRates & { source: string })[];
    byModel: (GradedRates & { model: string })[];
    byTier?: (GradedRates & { tier: string })[];
  };
  shadowEmissions: { total: GradedRates; bySource: (GradedRates & { source: string })[] };
  curatorConfidenceBands: (GradedRates & { side: "heuristic" | "model"; band: number })[];
  aiReviewer: {
    mode: string;
    buys: GradedRates;
    allReviewed: GradedRates;
    /** Its buys' 2x rate minus the rate of every pick it reviewed, in points. */
    liftPts: number | null;
    /** Mean squared error of its 2x odds (0.25 = a coin flip), and of the default model's own. */
    brier: number | null;
    curatorBrier: number | null;
    byDecision: (GradedRates & { mode: string; decision: string })[];
    probability2xBands: (GradedRates & { band: number })[];
  };
  aiJudge: AiJudgeState;
  samples: {
    byKind: (GradedRates & { kind: string })[];
    /** When the newest training sample was banked (null = none in a week), and how many landed in the last hour. */
    newestAnchorAt?: string | null;
    lastHourRows?: number;
  };
  /** Per-feature null rates and decile lifts from the newest training run, or null before one. */
  featureHealth?: FeatureHealthReport | null;
  /** What the winners that ran furthest had in common, from the newest training run. */
  runnerTraits?: RunnerTraitsReport | null;
  /** How far clean winners ran after the call: the feed's calls ("curated") and the training samples. */
  winnerRuns?: WinnerRuns[];
  /** Inputs the newest run held back as too new (or lately dead) to train on. */
  heldFeatures?: { feature: string; label: string; referencePct: number; recentPct: number }[];
  recentAiReviews: AiReviewRow[];
}

export interface FilterInput {
  name: string;
  mcapMin: number;
  mcapMax: number;
  minVolumeMcapRatio: number | null;
  minHolderGrowthPct: number | null;
  maxTop10HolderPct: number | null;
  maxDevWalletPct: number | null;
  maxRiskScore: number | null;
  excludeCriticalRiskFlags: boolean;
  minTokenAgeMinutes: number | null;
  maxTokenAgeMinutes: number | null;
  narrativeKeywords: string[];
  minScore: number | null;
  maxFreshTop10WalletPct: number | null;
  maxEmptyTop10WalletPct: number | null;
  minFirstBuyersHolding: number | null;
  maxFirstBuyersHolding: number | null;
  /** TokenSage narrative criteria; every one fails closed until the coin has a read. */
  narrativeCategories: string[];
  excludeNarrativeCategories: string[];
  excludeCopycats: boolean;
  excludeNarrativeRedFlags: boolean;
  excludeUnrelatedX: boolean;
  requireTrendMatch: boolean;
  excludeLateCopies: boolean;
  isActive: boolean;
  /** Listed on the public filter leaderboard (off by default). */
  shareOnLeaderboard: boolean;
}

export interface Filter extends FilterInput {
  id: string;
  createdAt: string;
  /** When the matching criteria last changed: the leaderboard record starts here. */
  criteriaChangedAt: string;
  trackRecord: { graded: number; won2x: number; won4x: number; won10x?: number; tenXGraded?: number } | null;
}

/** The fields that decide what a filter matches: what "Copy" copies. */
export type FilterCriteria = Omit<FilterInput, "name" | "isActive" | "shareOnLeaderboard">;

export interface FilterBoardEntry {
  id: string;
  name: string;
  /** Short tag from the filter id, to tell apart filters with the same name. */
  tag: string;
  rank: number | null;
  score: number | null;
  band: ScoreBand | null;
  graded: number;
  won2x: number;
  won4x: number;
  /** 10x within an hour (absent from older API builds). */
  won10x?: number;
  winRatePct: number | null;
  goalRatePct: number | null;
  tenXRatePct?: number | null;
  proven2xPct: number | null;
  proven4xPct: number | null;
  /** Average run size per graded alert, in doublings: 2 = calls ran to 4x on average. */
  avgRunDoublings: number | null;
  provenRunDoublings: number | null;
  recordSince: string;
  isActive: boolean;
  /** Its owner deleted it; kept on the board for its record (absent from older API builds). */
  retired?: boolean;
  criteria: FilterCriteria;
  mine: boolean;
}

export interface FilterBoard {
  generatedAt: string;
  windowDays: number;
  minGradedToRank: number;
  targets: { hitRate2xPct: number; hitRate4xPct: number; runDoublings: number; tenXPct?: number };
  ranked: FilterBoardEntry[];
  warmingUp: FilterBoardEntry[];
  sharedCount: number;
}

export interface AppConfig {
  mcapFilterMin: number;
  mcapFilterMax: number;
  scanBandMin: number;
  scanBandMax: number;
  /** TokenSage's top-level themes, for the narrative criteria (absent from older API builds). */
  narrativeCategories?: { id: string; label: string }[];
}

export interface WorkerHealth {
  jobs: {
    job: string;
    lastRunAt: string;
    lastSuccessAt: string | null;
    lastError: string | null;
    stale: boolean;
    hung: boolean;
  }[];
}

// ---- The curator contest (/curated/models) ----

export interface RecordSummary {
  calls: number;
  graded: number;
  winRatePct: number | null;
  goalRatePct: number | null;
  /** The 2x / 4x rate this record proves (after the score's prior misses), in percent. Absent from older API builds. */
  proven2xPct?: number | null;
  proven4xPct?: number | null;
  /** Share of graded calls that reached 10x within an hour; null when not tracked (absent from older API builds). */
  tenXRatePct?: number | null;
  /** Average doublings per graded call: a 2x is 1, a 4x is 2, a miss 0. */
  avgReturnDoublings: number | null;
  /**
   * Simulated return under the fixed exit plan (Leaderboard.exitPlan): calls with a number, the
   * average per call and the total, in percent of a stake. Absent from older API builds.
   */
  simCalls?: number;
  avgSimReturnPct?: number | null;
  totalSimReturnPct?: number | null;
  score: number | null;
}

export type ScoreBandId = "on-target" | "closing-in" | "getting-there" | "far-off";

export interface ScoreBand {
  id: ScoreBandId;
  /** Scores at or above this are in the band. */
  min: number;
  label: string;
  meaning: string;
}

/** How a score was earned: the proven rates, the points they made, and the evidence behind them. */
export interface ScoreBasis {
  points2x: number;
  points4x: number;
  /** Points from the 10x-within-an-hour rate (absent from older API builds). */
  points10x?: number;
  proven10xPct?: number;
  /** Points from run size (absent from an API that predates it). */
  pointsRun?: number;
  proven2xPct: number;
  proven4xPct: number;
  /** The run size proven, in doublings per call. */
  provenRunDoublings?: number;
  /** Calls' worth of evidence: graded live calls plus the backtest's share. */
  evidenceCalls: number;
  backtestCalls: number;
  liveCalls: number;
}

export type ContestantRole = "rules" | "learner" | "stacked" | "blend" | "agreement" | "narrative";

export interface WinnerRuns {
  population: "curated" | "samples" | string;
  winners: number;
  /** Winners whose run watch has ended (the rest are still being watched). */
  finished: number;
  medianPeakMultiple: number | null;
  bestPeakMultiple: number | null;
  reached4xPct: number | null;
  reached10xPct: number | null;
  medianMinutesToPeak: number | null;
}

export interface RunnerTraitsReport {
  winners: number;
  /** A big runner went at least this far (the top quarter of winners by run peak). */
  bigRunnerMultiple: number | null;
  medianRunMultiple: number | null;
  traits: {
    feature: string;
    label: string;
    topThirdLift: number;
    bottomThirdLift: number;
    present: number;
  }[];
}

export interface FeatureHealthReport {
  rows: number;
  baseWinRatePct: number;
  features: {
    feature: string;
    label: string;
    nullRatePct: number;
    topDecileLift: number | null;
    bottomDecileLift: number | null;
    present: number;
  }[];
}

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  description: string;
  /** The same in plain words. Absent from older API builds. */
  summary?: string;
  role: ContestantRole;
  isDefault: boolean;
  status: "calling" | "silent" | "untrained";
  composite: {
    score: number | null;
    /** The band the score falls in; null without a score. Absent from older API builds. */
    band?: ScoreBand | null;
    liveWeight: number;
    /** Fewer graded live calls than the board's minLiveCallsToRank: shown, ranked behind the seasoned. */
    warmingUp?: boolean;
    /** How the score was earned; null without a score. Absent from older API builds. */
    basis?: ScoreBasis | null;
    live: RecordSummary;
    exam: RecordSummary;
  };
  /** The score in a sentence. Absent from older API builds. */
  scoreExplained?: string;
  /** Its live record on high-conviction calls alone; null with none graded. */
  highConviction?: RecordSummary | null;
  model: {
    id: string;
    trainedAt: string;
    trainingRows: number;
    cutoffMeetsTargets: boolean | null;
    calibrationCalls?: number;
  } | null;
  /** Evolving seats: the recipe holding the seat now (generation 0 = a founding recipe). */
  lane: { generation: number; parentName: string | null; bornAt: string } | null;
  /** Rules only: the checks it runs now. Absent from older API builds; null before a run recorded it. */
  rules?: {
    source: "hand-tuned" | "learned";
    lines: string[];
    teacherName: string | null;
    derivedAt: string | null;
    agreementPct: number | null;
    reason: string;
  } | null;
}

export interface EvolutionEvent {
  slot: string;
  name: string;
  description: string;
  generation: number;
  parentName: string | null;
  examScore: number | null;
  bornAt: string;
  retiredAt: string | null;
  retiredReason: string | null;
}

export interface Leaderboard {
  window: { days: number; since: string };
  targets: { hitRate2xPct: number; hitRate4xPct: number };
  scoring: {
    weights: { winRate: number; goalRate: number; tenXRate?: number; runSize?: number; avgReturn?: number };
    /** The 10x-within-an-hour rate target, in percent (absent from older API builds). */
    tenXTargetPct?: number;
    /** Run-size target, in doublings per call (2 = a 4x average). */
    runTargetDoublings?: number;
    /** Calls' worth the backtest counts for at most; live weighs the same at this many graded calls. */
    livePivotCalls: number;
    /** Calls counted as misses on top of every record (absent from older API builds). */
    priorCalls?: number;
    minLiveCallsToRank?: number;
    /** The score's plain-language bands, highest first (absent from older API builds). */
    bands?: ScoreBand[];
    summary: string;
  };
  /** The fixed exit plan the simulated returns follow, in a sentence (absent from older API builds). */
  exitPlan?: string;
  defaultModel: string;
  /** The first of selectedModels (the single-model feed other clients read). */
  selectedModel: string;
  /** Every model whose calls this user's combined feed shows, in roster order. */
  selectedModels: string[];
  /** True when the user hasn't picked any (their feed follows the default). */
  followsDefault: boolean;
  /** Whether model calls are mixed into the combined feed at all. */
  showModelAlerts: boolean;
  /** The user follows the best performer (absent from API builds before Settings). */
  followBest?: boolean;
  /** When and why the default (the best performer) was last chosen; null before the first pick. */
  champion?: {
    id: string;
    name: string;
    score: number | null;
    liveGraded: number;
    reason: string;
    chosenAt: string;
    minLiveGraded: number;
    margin: number;
  } | null;
  entries: LeaderboardEntry[];
  evolution: {
    challengersPerRun: number;
    minAgeHours: number;
    margin: number;
    runEveryHours: number;
    /** Hours a winning challenger waits for fresh calls before it takes the seat (0 = none). */
    probationHours?: number;
    /** The challenger waiting on probation, if any. */
    probation?: { slot: string; name: string; seatName: string; startedAt: string } | null;
    history: EvolutionEvent[];
  };
}

// ---- Settings (/settings) ----

export type AlertSoundId = "chime" | "ping" | "bell" | "coin" | "radar";

export interface AlertPrefs {
  soundEnabled: boolean;
  sound: AlertSoundId;
  /** 0-100. */
  volume: number;
  browserNotifications: boolean;
  notifyOn: { filterMatches: boolean; modelCalls: boolean };
}

/** Card fields a user can hide (the API's CARD_FIELDS). */
export type CardField =
  | "tokenName"
  | "time"
  | "modelPill"
  | "conviction"
  | "calibrated"
  | "result"
  | "alert"
  | "now"
  | "peak"
  | "ath"
  | "vol"
  | "score"
  | "holders"
  | "age"
  | "top10"
  | "fresh"
  | "empty"
  | "snipers"
  | "dev"
  | "reasons"
  | "mint"
  | "links"
  | "sage";

/** Trading sites a card can link the token to (the API's QUICK_LINKS). */
export type QuickLink = "terminal" | "axiom" | "gmgn";

/** How the Live feed looks for this user (apps/api/src/feedAppearance.ts). */
export interface FeedAppearance {
  theme: "auto" | "dark" | "light";
  /** #rrggbb, or null for the theme's own color. */
  accent: string | null;
  mine: string | null;
  win: string | null;
  loss: string | null;
  density: "compact" | "cozy" | "roomy";
  /** Desktop columns; 0 fits as many as the width allows. */
  columns: number;
  cardWidth: "narrow" | "normal" | "wide";
  phoneColumns: number;
  /** Percent, 85-125. */
  textSize: number;
  corners: "square" | "rounded" | "round";
  avatar: "small" | "normal" | "large";
  sourceStripe: boolean;
  learningNote: boolean;
  /** Volume tiles (5m / 1h / 24h) on the cards; off by default, the score tile takes their place. */
  volume: boolean;
  /** Color the Score tile red to green against recent alerts' scores; on by default. */
  scoreColor: boolean;
  /** The model's reasons under a model call; off by default. */
  reasons: boolean;
  /** Trading sites each card links to; Padre's Trading Terminal by default. */
  quickLinks: QuickLink[];
  hidden: CardField[];
}

/** The composite score's current weights (GET /config/score). */
export interface ScoreWeightsInfo {
  weights: { momentum: number; freshness: number; holderQuality: number; narrative: number };
  adoptedAt: string | null;
  /** Recent alerts' score spread the Score tile colors against (red at p10, green at p90). */
  scale?: { p10: number; p90: number; sample: number };
  history: {
    at: string;
    momentum: number;
    freshness: number;
    holderQuality: number;
    narrative: number;
    reason: string;
  }[];
}

export interface Settings {
  alerts: AlertPrefs;
  /** Absent from API builds before feed appearance. */
  appearance?: FeedAppearance;
  account: {
    walletAddress: string;
    memberSince: string;
    access: {
      hasAccess: boolean;
      level: "admin" | "whitelist" | "subscription" | "none";
      expiresAt: string | null;
      subscription: { since: string; expiresAt: string; source: "BURN" | "ADMIN_GRANT" } | null;
      burns: number;
    };
  };
}

// ---- Telegram alerts (/telegram) ----

/** A Telegram chat linked to this account (GET /telegram). Never carries Telegram's own chat id. */
export interface TelegramChat {
  id: string;
  kind: "private" | "group" | "supergroup" | "channel" | string;
  title: string | null;
  linkedByName: string | null;
  filterMatches: boolean;
  modelCalls: boolean;
  enabled: boolean;
  /** The parts of the card this chat switched off (TELEGRAM_ALERT_PARTS keys); [] is the whole card. */
  hidden: TelegramAlertPart[];
  lastSentAt: string | null;
  /** What Telegram last answered when a send failed; null while all is well. */
  lastError: string | null;
  createdAt: string;
}

/** The parts of a Telegram alert a chat can switch off, in the order the card shows them. */
export const TELEGRAM_ALERT_PARTS = [
  { key: "image", label: "Token picture" },
  { key: "stats", label: "Mcap, holders, volume, age" },
  { key: "conviction", label: "Model conviction" },
  { key: "reasons", label: "Reasons" },
  { key: "filters", label: "Filter and score" },
  { key: "mint", label: "Mint address" },
  { key: "links", label: "Trade links" },
  { key: "sage", label: "TokenSage read link" },
] as const;
export type TelegramAlertPart = (typeof TELEGRAM_ALERT_PARTS)[number]["key"];

export interface TelegramState {
  /** The server has a bot token; false means the feature is off for everyone. */
  configured: boolean;
  /** The bot's @username (without the @), or null while Telegram hasn't answered. */
  botUsername: string | null;
  chats: TelegramChat[];
  linkTtlMs: number;
}

/** POST /telegram/link/code: a one-time code inside the two t.me deep links. */
export interface TelegramLinkCode {
  /** For asking whether the code was used (GET /telegram/link/code/:codeId). */
  codeId: string;
  code: string;
  expiresAt: string;
  ttlMs: number;
  /** Opens a private chat with the bot and sends the code. */
  privateUrl: string;
  /** Telegram asks which group to add the bot to, then sends the code there. */
  groupUrl: string;
}

/**
 * GET /curated/lighthouse/history and /guest/lighthouse/history: the Lighthouse's kept-for-good
 * hourly sums per hour, day or week. Sums and counts only; the tab computes every rate.
 */
export type LighthouseHistoryBucket = "hour" | "day" | "week";
export type LighthouseDimension =
  | "category"
  | "subcategory"
  | "flag"
  | "referentKind"
  | "referentSupport"
  | "xVerdict"
  | "pairKind"
  | "copy"
  | "news";
export interface LighthouseSums {
  screened: {
    calls: number;
    graded: number;
    won2x: number;
    won4x: number;
    won10x: number;
    tenXGraded: number;
    returnN: number;
    returnSum: number;
  };
  reads: {
    total: number;
    described: number;
    deep: number;
    failed: number;
    referentConfidenceSum: number;
    referentConfidenceN: number;
    xFitSum: number;
    xFitN: number;
    copiesRecent: number;
    copiesAnswered: number;
    trendMatched: number;
    trendAnswered: number;
  };
  alerts: {
    total: number;
    described: number;
    graded: number;
    won2x: number;
    won4x: number;
    won10x: number;
    /** Calls whose 10x verdict is in: the 10x rate's denominator. Absent from older API builds. */
    tenXGraded?: number;
    returnN: number;
    returnSum: number;
  };
}
export interface LighthouseLabelTally {
  label: string;
  count: number;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  tenXGraded?: number;
}
export interface LighthouseHistory {
  window: {
    days: number;
    since: string | null;
    bucket: LighthouseHistoryBucket;
    dimension: LighthouseDimension;
  };
  coverage: { oldestHour: string | null; newestHour: string | null; summedAt: string | null };
  exitPlan: string;
  totals: LighthouseSums;
  /** The same span just before the window; null when the window is everything. */
  previous: LighthouseSums | null;
  series: ({ at: string } & LighthouseSums)[];
  labels: {
    dimension: LighthouseDimension;
    bucket: LighthouseHistoryBucket;
    /** The labels drawn as their own series; everything else is "other". */
    top: string[];
    buckets: { at: string; rows: LighthouseLabelTally[] }[];
  };
}

/** GET /curated/lighthouse and /guest/lighthouse: what TokenSage sees across new coins, aggregates only. */
export interface LighthouseCount {
  label: string;
  count: number;
}
export interface LighthouseTally {
  label: string;
  alerts: number;
  graded: number;
  won2x: number;
  won4x: number;
  won10x: number;
  /** Calls whose 10x verdict is in: the 10x rate's denominator. Absent from older API builds. */
  tenXGraded?: number;
  /** Calls with a simulated return under the exit plan, and their sum (percent). */
  returnN: number;
  returnSum: number;
}
export interface MarketLighthouse {
  window: { days: number; since: string; bucketHours: number };
  tokenSage: { on: boolean; lastCycleAt: string | null };
  reads: {
    total: number;
    described: number;
    deep: number;
    quick: number;
    failed: number;
    /** Described coins TokenSage could not say what they are about (no referent). */
    noReferent: number;
    newestAt: string | null;
  };
  avgReferentConfidence: number | null;
  avgXFit: number | null;
  tide: { buckets: string[]; series: { label: string; values: number[] }[] };
  topLevelCategories: LighthouseCount[];
  categories: LighthouseCount[];
  referentKinds: LighthouseCount[];
  referentSupport: LighthouseCount[];
  flags: LighthouseCount[];
  xVerdicts: LighthouseCount[];
  pairKinds: LighthouseCount[];
  copies: LighthouseCount[];
  news: LighthouseCount[];
  /** Every token that passed the pre-checks, graded from its decision moment. */
  screened: {
    bucketHours: number;
    calls: number;
    graded: number;
    hit2xPct: number | null;
    hit4xPct: number | null;
    hit10xPct: number | null;
    tenXGraded: number;
    avgReturnPct: number | null;
    returnGraded: number;
    exitPlan: string;
    byBucket: {
      at: string;
      graded: number;
      hit2xPct: number | null;
      hit4xPct: number | null;
      hit10xPct: number | null;
      avgReturnPct: number | null;
    }[];
    /**
     * The screened field by hour of the day (UTC) over all the hourly history kept, always 24
     * entries. Absent from older API builds.
     */
    byHourOfDay?: {
      /** Days of history behind the figures; 0 before the rollup has run. */
      days: number;
      hours: {
        hour: number;
        calls: number;
        graded: number;
        hit2xPct: number | null;
        avgReturnPct: number | null;
        returnGraded: number;
      }[];
    };
    checks: {
      freshWalletMaxPct: number;
      /** Rejected at this share of empty top-10 wallets or more. */
      emptyWalletRejectPct: number;
      mcapMinUsd: number;
      mcapMaxUsd: number;
      maxAgeMinutes: number;
      minBuySharePct: number;
    };
  };
  outcomes: {
    alerts: number;
    described: number;
    graded: number;
    won2x: number;
    won4x: number;
    byCategory: LighthouseTally[];
    byXVerdict: LighthouseTally[];
    byCopy: LighthouseTally[];
  };
}
