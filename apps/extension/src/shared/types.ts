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

/** What the side panel may ask the service worker. Only the extension's own pages can send these. */
export type PanelRequest =
  | { type: "status" }
  | { type: "feed" }
  | { type: "disconnect" }
  | { type: "saveSettings"; settings: OverlaySettings };

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
  settings: OverlaySettings;
  problem: Problem;
}
