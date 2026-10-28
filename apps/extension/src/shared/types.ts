import type { TooltipPrefs } from "./tooltip";
/**
 * The API's shapes (apps/api/src/extensionLookup.ts and overlaySettings.ts), as the extension
 * reads them. `sites` picks which sites the panel offers to open a token on; `style` is kept for
 * the account's stored shape and not used by the panel. Kept by hand: the extension imports nothing from the monorepo at runtime.
 */
export const SITES = ["axiom", "terminal", "gmgn"] as const;
export type Site = (typeof SITES)[number];
export const RING_STYLES = ["halo", "brackets", "rail"] as const;
export type RingStyle = (typeof RING_STYLES)[number];

export const FLAG_IDS = [
  "bundledSupplyPct",
  "sniperTopHolderCount",
  "linkedWalletPct",
  "devWalletPct",
  "top10HolderPct",
  "freshTop10WalletPct",
  "emptyTop10WalletCount",
  "cexFundedPct",
  "kolRecentBuyers",
  "mintAuthorityActive",
] as const;
export type FlagId = (typeof FLAG_IDS)[number];

export interface OverlaySettings {
  rings: { modelAlerts: boolean; filterMatches: boolean; aiBuyOnly: boolean; riskRing: boolean };
  flags: Record<FlagId, { on: boolean; threshold: number | null }>;
  sites: Record<Site, boolean>;
  style: { ring: RingStyle; calmMotion: boolean };
}

export interface OverlayStats {
  takenAt: string;
  marketCapUsd: number;
  holderCount: number | null;
  bundledSupplyPct: number | null;
  sniperTopHolderCount: number | null;
  linkedWalletPct: number | null;
  devWalletPct: number | null;
  top10HolderPct: number | null;
  freshTop10WalletPct: number | null;
  /** Top-10 holders holding nothing else (re-measured each scan); absent before 0.8.1's API. */
  emptyTop10WalletCount?: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
  /** The same numbers about five minutes back, for the trend arrows; absent before 0.9.0's API. */
  earlier?: OverlayEarlier | null;
}

/** A coin's flag numbers some minutes back (the API's OverlayStats.earlier). */
export type OverlayEarlier = { takenAt: string } & Partial<Record<FlagId, number | boolean | null>>;

/** A creator's launches in the last 14 days and how they went (the API's DevLaunchRisk row). */
export interface OverlayLaunchRecord {
  /** Dev launch score, 0-100, higher is riskier. */
  score: number;
  launches: number;
  inBand: number;
  wins: number;
  stops: number;
}

export interface OverlayDev {
  wallet: string;
  /** Null when the creator has fewer than two launches in 14 days and none reached the band. */
  record: OverlayLaunchRecord | null;
  /** Every creator the same funder paid for, pooled, when there are two or more. */
  family: (OverlayLaunchRecord & { creators: number }) | null;
}

/** The safety screen's verdict on the coin's newest scan (apps/api/src/extensionLookup.ts). */
export interface OverlaySafety {
  passed: boolean;
  reasons: string[];
  at: string;
}

export interface OverlayToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** The token's logo URL as the API stored it; checked before use (panel/card.ts). */
  image: string | null;
  liveMcapUsd: number | null;
  stats: OverlayStats | null;
  /** Absent from answers before 0.7.0's API. */
  safety?: OverlaySafety | null;
  /** The coin's creator and its launch record; absent before 0.9.0's API, null when unknown. */
  dev?: OverlayDev | null;
  modelCalls: {
    model: string;
    name: string | null;
    tier: string | null;
    confidence: number;
    calibratedPct: number | null;
    at: string;
    mcapUsd: number;
    /** The highest market cap since the call; absent before 0.9.0's API. */
    peakMcapUsd?: number | null;
  }[];
  filterMatches: {
    filterId: string;
    filterName: string;
    at: string;
    mcapUsd: number | null;
    peakMcapUsd?: number | null;
  }[];
  ai: { decision: string; probability2x: number | null; reasoning: string | null; at: string } | null;
}

/** A coin's latest bubble map with the site's category totals (apps/api/src/extensionBubble.ts). */
export type OverlayTrait = "blockZero" | "sniper" | "fresh" | "empty";

export interface OverlayBubbleHolder {
  wallet: string;
  pct: number;
  cluster: number | null;
  sameTime: number | null;
  trait: OverlayTrait | null;
  cex: boolean;
  creatorTied: boolean;
}

export interface OverlayCount {
  count: number;
  of: number;
}

export interface OverlayBubbleMap {
  mint: string;
  symbol: string | null;
  readAt: string | null;
  scanAt: string | null;
  top50: boolean;
  holders: OverlayBubbleHolder[];
  clusters: { funder: string; pct: number; count: number; creatorLinked: boolean }[];
  sameTime: { pct: number; count: number }[];
  totals: OverlayBubbleTotals;
}

export interface OverlayBubbleTotals {
  linkedPct: number | null;
  linkedCount: OverlayCount | null;
  kolBundledPct: number | null;
  bundledPct: number | null;
  sameMinutePct: number | null;
  sameMinuteCount: OverlayCount | null;
  cexFundedPct: number | null;
  cexFundedCount: OverlayCount | null;
  devTiedPct: number | null;
  transferredPct: number | null;
  transferredCount: OverlayCount | null;
  top10Pct: number | null;
  traits: { trait: OverlayTrait; count: number; pct: number }[];
}

/** One coin the reader's wallet bought, with its PnL (apps/api/src/extensionBuddy.ts). */
export interface BuddyCoin {
  mint: string;
  /** The wallet that traded it; absent before 0.9.0's API (then the account's). */
  wallet?: string;
  entryAt: string;
  lastTradeAt: string;
  buys: number;
  sells: number;
  spentSol: number;
  gotSol: number;
  held: number;
  chainHeld: number | null;
  closed: boolean;
  mismatch: boolean;
  entryMcapUsd: number | null;
  nowMcapUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  priceAt: string | null;
  priceSource: "curve" | "market" | "stored" | null;
  token: OverlayToken | null;
  symbol: string | null;
  name: string | null;
  image: string | null;
}

/** The last 24 hours of trading across the wallets followed (the API's BuddySummary). */
export interface BuddySummary {
  hours: number;
  trades: number;
  buys: number;
  sells: number;
  coins: number;
  volumeSol: number;
  closed: number;
  open: number;
  winRatePct: number | null;
  realizedSol: number;
  unrealizedSol: number | null;
  bestMultiple: number | null;
  calledFirst: number;
  entries: number;
}

export interface BuddyAnswer {
  coins: BuddyCoin[];
  /** The wallets followed, the account's first; absent before 0.9.0's API. */
  wallets?: string[];
  /**
   * Wallets the panel asked for that aren't linked to the account on Settings, so aren't
   * followed (Card 11); absent before that API, and when every one asked for is linked.
   */
  notLinked?: string[];
  summary?: BuddySummary | null;
  solUsd: number | null;
  /** The account has Pro Mode: each coin gets its trade box. */
  pro: boolean;
  readAt: string;
  chainAt: string | null;
}

/** What the side panel may ask the service worker. Only the extension's own pages can send these. */
export type PanelRequest =
  | { type: "status" }
  | { type: "feed" }
  /** One API call of the site's own bubble map (map/siteMap.ts), answered through the key. */
  | { type: "site"; method: string; path: string; body: string | null; id?: string }
  /** The map gave up the read with this id (siteMap.ts): stop it at the API too. */
  | { type: "siteCancel"; id: string }
  | { type: "buddy"; cached?: boolean }
  | { type: "disconnect" }
  | { type: "saveSettings"; settings: OverlaySettings }
  | { type: "tooltip" }
  | { type: "saveTooltip"; prefs: TooltipPrefs }
  /** Any coin by its address, for the panel's lookup: its card and its bubble map's top holders. */
  | { type: "coin"; mint: string }
  /** The alerts the panel has shown, so the toolbar icon's count of unread ones clears. */
  | { type: "alertsSeen"; mints: string[] }
  /** Hides a coin's ring, pill, card and alerts for a while (0 minutes wakes it). */
  | { type: "snooze"; mint: string; minutes: number }
  /** The coin a page's "Look up" asked the panel to show, taken once. */
  | { type: "pendingCoin" };

export interface CoinAnswer {
  /** Null when the scanner never stored the coin. */
  token: OverlayToken | null;
  /** Null when the coin has no map, or the reader can't open it. */
  map: OverlayBubbleMap | null;
  problem: Problem;
}

/** A bubble map read: the map (null when the coin has no scan yet), or why it couldn't be read. */
export interface BubbleAnswer {
  map: OverlayBubbleMap | null;
  problem: Problem | "untracked";
}

export interface BuddyRead {
  /** Null until the first read lands; the last good answer when a read fails. */
  buddy: BuddyAnswer | null;
  problem: Problem;
}

/** Why nothing could be read: not connected, the key was refused, or the network failed. */
export type Problem = "disconnected" | "refused" | "offline" | null;

export interface FeedAnswer {
  /** The reader's latest alerted tokens, newest first; the last good list when a read fails. */
  tokens: OverlayToken[];
  problem: Problem;
}

export interface Status {
  connected: boolean;
  wallet: string | null;
  /** The account sees the AI reviewer's verdicts (admins only, as on the site). */
  aiReviews: boolean;
  /** The account has Pro Mode (trades from TrenchScanner's Trade panel). */
  pro: boolean;
  settings: OverlaySettings;
  problem: Problem;
}

/**
 * What a ring page (the rings content script on Axiom, Terminal or GMGN) may ask
 * the service worker. It holds no key: it asks about the addresses on screen and draws answers.
 */
export type ContentRequest =
  | { type: "lookup"; mints: string[] }
  | { type: "settings" }
  | { type: "tooltip" }
  /** A tracked coin's bubble map totals, for the tooltip's map lines. */
  | { type: "totals"; mint: string }
  /** The reader's feed, for the on-page alerts (only while they are on). */
  | { type: "alerts" }
  /** The safety verdicts of the coins on a board (only while the hide-or-mark option is on). */
  | { type: "safety"; mints: string[] }
  /** The stats of the coins on a board (only while the pill-on-every-coin option is on). */
  | { type: "stats"; mints: string[] }
  /** The open token page's coin's top holders, for the holder markers (only while they are on). */
  | { type: "holders"; mint: string }
  /** The tooltip's Snooze: hides the coin's ring, pill and alerts for a while. */
  | { type: "snooze"; mint: string; minutes: number }
  /** The tooltip's Look up: opens the side panel on the coin. */
  | { type: "openCoin"; mint: string };

export interface StatsAnswer {
  /** Each coin asked about that TrenchScanner has numbers for, by mint; no calls, matches or AI. */
  tokens: Record<string, OverlayToken>;
  problem: Problem;
}

export interface SafetyAnswer {
  /** The verdict of each coin asked about that the scanner has screened, by mint. */
  verdicts: Record<string, OverlaySafety>;
  problem: Problem;
}

export interface LookupAnswer {
  /** The reader's alerted tokens among those asked, by mint. A mint absent here wasn't alerted. */
  tokens: Record<string, OverlayToken>;
  problem: Problem;
}
