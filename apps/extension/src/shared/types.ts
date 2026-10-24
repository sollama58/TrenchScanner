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
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
}

export interface OverlayToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** The token's logo URL as the API stored it; checked before use (panel/card.ts). */
  image: string | null;
  liveMcapUsd: number | null;
  stats: OverlayStats | null;
  modelCalls: {
    model: string;
    name: string | null;
    tier: string | null;
    confidence: number;
    calibratedPct: number | null;
    at: string;
    mcapUsd: number;
  }[];
  filterMatches: { filterId: string; filterName: string; at: string; mcapUsd: number | null }[];
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
  totals: {
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
  };
}

/** One coin the reader's wallet bought, with its PnL (apps/api/src/extensionBuddy.ts). */
export interface BuddyCoin {
  mint: string;
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

export interface BuddyAnswer {
  coins: BuddyCoin[];
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
  | { type: "bubble"; mint: string }
  | { type: "buddy" }
  | { type: "disconnect" }
  | { type: "saveSettings"; settings: OverlaySettings };

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
