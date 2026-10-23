/**
 * The API's shapes (apps/api/src/extensionLookup.ts and overlaySettings.ts), as the extension
 * reads them. Kept by hand: the extension imports nothing from the monorepo at runtime.
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

export interface OverlayLookup {
  tokens: OverlayToken[];
  untracked: string[];
}

/** What a content script may ask the service worker. Nothing else is answered. */
export type ContentRequest =
  | { type: "lookup"; mints: string[] }
  | { type: "settings" }
  | { type: "health"; site: Site; rows: number; mints: number; paused: boolean };

/** What the popup may ask the service worker. Only the extension's own pages can send these. */
export type PopupRequest =
  | { type: "status" }
  | { type: "connect"; key: string }
  | { type: "disconnect" }
  | { type: "saveSettings"; settings: OverlaySettings };

export interface LookupAnswer {
  /** Tracked tokens by mint. A mint absent here was untracked or not answered. */
  tokens: Record<string, OverlayToken>;
  /** Why nothing could be read: not connected, the key was refused, or the network failed. */
  problem: "disconnected" | "refused" | "offline" | null;
}

export interface Status {
  connected: boolean;
  wallet: string | null;
  settings: OverlaySettings;
  problem: LookupAnswer["problem"];
  /** The active tab's overlay, when it is on one of the three sites. */
  page: { site: Site; rows: number; mints: number; paused: boolean } | null;
}
