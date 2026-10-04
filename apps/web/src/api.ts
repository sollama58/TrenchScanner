/**
 * The API client. Every call carries the session cookie (credentials: "include"): the API sets it
 * on sign-in and reads it on every request, and this page lives on a different origin from it.
 */

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:4000";

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
  const headers = new Headers(init.headers);
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

// ---- Shapes the API returns (only the fields this UI reads) ----

export interface User {
  id: string;
  walletAddress: string;
  isAdmin: boolean;
}

export interface Subscription {
  hasAccess: boolean;
  reason: string | null;
  expiresAt: string | null;
}

export interface Token {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  graduated?: boolean | null;
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
  ageMinutes: number | null;
  graduated: boolean | null;
  score: number;
}

export type OutcomeStatus = "watching" | "won" | "missed" | "disqualified" | "unknown";

export interface Outcome {
  status: OutcomeStatus;
  hit2x: boolean;
  hitGoal: boolean | null;
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  peak24hReturnPct: number | null;
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
  reasons: string[];
  alertedAt: string;
  outcome: Outcome;
  aiReview?: AdminAiReview;
  /** On the combined feed: every model that called this token, first call first. */
  calledBy?: ModelCall[];
}

export interface ModelCall {
  model: string | null;
  modelName: string | null;
  confidence: number;
  alertedAt: string;
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
  filter: { id: string; name: string } | null;
  curated: CuratedMeta | null;
  // Match-only outcome columns.
  hit2xIn1h?: boolean | null;
  hit4xIn1h?: boolean | null;
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

export interface MatchPage {
  matches: Card[];
  page: number;
  pageSize: number;
  totalCount: number;
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
    bestPeak24hReturnPct: number | null;
  };
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
  learner: "logistic" | "gbdt";
  status: string;
  trainingRows: number;
  trainingFrom: string;
  trainingTo: string;
  activatedAt: string | null;
  verdict: { promote: boolean; reason: string } | null;
  familyComparison: {
    learner: "logistic" | "gbdt";
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
  outcome: "pending" | "won" | "won4x" | "missed" | "stopped" | "unknown";
  reasoning?: string | null;
  risks?: string[];
  error?: string | null;
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
    learner: "logistic" | "gbdt";
    threshold: number;
    features: { feature: string; label: string; sharePct: number; direction: 1 | -1 | null }[];
  } | null;
  runs: ModelRun[];
  curatedAlerts: {
    total: GradedRates;
    bySource: (GradedRates & { source: string })[];
    byModel: (GradedRates & { model: string })[];
  };
  shadowEmissions: { total: GradedRates; bySource: (GradedRates & { source: string })[] };
  curatorConfidenceBands: (GradedRates & { side: "heuristic" | "model"; band: number })[];
  aiReviewer: {
    mode: string;
    buys: GradedRates;
    allReviewed: GradedRates;
    byDecision: (GradedRates & { mode: string; decision: string })[];
    probability2xBands: (GradedRates & { band: number })[];
  };
  samples: { byKind: (GradedRates & { kind: string })[] };
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
  isActive: boolean;
}

export interface Filter extends FilterInput {
  id: string;
  createdAt: string;
  trackRecord: { graded: number; won2x: number; won4x: number } | null;
}

export interface AppConfig {
  mcapFilterMin: number;
  mcapFilterMax: number;
  scanBandMin: number;
  scanBandMax: number;
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
  /** Average doublings per graded call: a 2x is 1, a 4x is 2, a miss 0. */
  avgReturnDoublings: number | null;
  score: number | null;
}

export type ContestantRole = "rules" | "learner" | "stacked";

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  description: string;
  role: ContestantRole;
  isDefault: boolean;
  status: "calling" | "silent" | "untrained";
  composite: { score: number | null; liveWeight: number; live: RecordSummary; exam: RecordSummary };
  model: { id: string; trainedAt: string; trainingRows: number; cutoffMeetsTargets: boolean | null } | null;
  /** Evolving seats: the recipe holding the seat now (generation 0 = a founding recipe). */
  lane: { generation: number; parentName: string | null; bornAt: string } | null;
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
    weights: { winRate: number; goalRate: number; avgReturn: number };
    livePivotCalls: number;
    summary: string;
  };
  defaultModel: string;
  /** The first of selectedModels (the single-model feed other clients read). */
  selectedModel: string;
  /** Every model whose calls this user's combined feed shows, in roster order. */
  selectedModels: string[];
  /** True when the user hasn't picked any (their feed follows the default). */
  followsDefault: boolean;
  /** Whether model calls are mixed into the combined feed at all. */
  showModelAlerts: boolean;
  entries: LeaderboardEntry[];
  evolution: {
    challengersPerRun: number;
    minAgeHours: number;
    margin: number;
    runEveryHours: number;
    history: EvolutionEvent[];
  };
}
