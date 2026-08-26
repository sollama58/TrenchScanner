export interface User {
  id: string;
  walletAddress: string;
  createdAt: string;
  /** True when this wallet is in the deployment's ADMIN_WALLET_ADDRESSES - gates the Admin nav link. */
  isAdmin: boolean;
}

export interface UserFilter {
  id: string;
  userId: string;
  name: string;
  mcapMin: number;
  mcapMax: number;
  minVolumeMcapRatio: number | null;
  minHolderGrowthPct: number | null;
  maxTop10HolderPct: number | null;
  minTokenAgeMinutes: number | null;
  maxTokenAgeMinutes: number | null;
  narrativeKeywords: string[];
  minScore: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FilterInput = Omit<UserFilter, "id" | "userId" | "createdAt" | "updatedAt">;

export interface Token {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  firstSeenAt: string;
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  narrativeTags: string[];
}

export interface TokenSnapshot {
  id: string;
  tokenId: string;
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
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  lpBurned: boolean | null;
  ageMinutes: number | null;
  score: number | null;
  scoreMomentum: number | null;
  scoreHolderHealth: number | null;
  scoreAge: number | null;
  scoreNarrative: number | null;
  rugScreenPassed: boolean;
  rugScreenReasons: string[];
}

export interface Match {
  id: string;
  userId: string;
  filterId: string;
  tokenId: string;
  snapshotId: string;
  matchedAt: string;
  score: number;
  deliveredDashboard: boolean;
  deliveredTelegram: boolean;
  digestSentAt: string | null;
  /** Backtesting data: highest mcap seen since this match, updated daily. Both null until the
   *  outcome-tracking job's first run after the match - see apps/worker/src/jobs/outcomeTrackingJob.ts. */
  peakMcapUsd: number | null;
  peakMcapAt: string | null;
  token: Token;
  snapshot: TokenSnapshot;
  filter: { id: string; name: string };
}

export type AlertMode = "REALTIME" | "DIGEST" | "BOTH" | "OFF";

export interface TelegramStatus {
  /** False when this deployment has no TELEGRAM_BOT_TOKEN configured yet - Settings hides the link flow entirely rather than offering a code nothing will ever consume. */
  enabled: boolean;
  linked: boolean;
  alertMode: AlertMode;
  pendingLinkCode: string | null;
  botUsername: string | null;
}

export interface TelegramLinkResponse {
  linkCode: string;
  expiresAt: string;
  deepLink: string | null;
}

export interface WorkerHeartbeat {
  job: string;
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  stale: boolean;
}

export interface WorkerHealth {
  jobs: WorkerHeartbeat[];
}

// ── Admin ────────────────────────────────────────────────────────────────
export interface AdminStats {
  totalUsers: number;
  totalActiveFilters: number;
  totalTrackedTokens: number;
  totalMatches: number;
  matches24h: number;
  telegramLinkedUsers: number;
}

export interface AdminUser {
  id: string;
  walletAddress: string;
  createdAt: string;
  filterCount: number;
  matchCount: number;
  telegramLinked: boolean;
  alertMode: AlertMode | null;
}

/** A tracked token's most recent snapshot - upstream of both the rug screen and per-user filter
 *  matching, so this is what "before any filtering" actually means in this codebase. */
export interface AdminFeedSnapshot extends TokenSnapshot {
  token: Token;
}

export interface AdminLiveFeed {
  snapshots: AdminFeedSnapshot[];
  /** Watchlisted mints with zero snapshots yet (outside the mcap band, or not yet re-checked). */
  watchlistOnlyCount: number;
}

export interface AdminConfig {
  scanIntervalMinutes: number;
  digestHourUtc: number;
  mcapFilterMin: number;
  mcapFilterMax: number;
  watchlistTtlHours: number;
  watchlistMaxTracked: number;
  cleanupHourUtc: number;
  snapshotRetentionDays: number;
  staleTokenRetentionDays: number;
  outcomeTrackingHourUtc: number;
  telegramConfigured: boolean;
}
