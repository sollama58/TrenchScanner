import { FLAG_IDS, type FlagId, type OverlaySettings } from "./types";

/** The API's defaults (apps/api/src/overlaySettings.ts), used until the account's arrive. */
export const DEFAULT_SETTINGS: OverlaySettings = {
  rings: { modelAlerts: true, filterMatches: true, aiBuyOnly: false, riskRing: true },
  flags: {
    bundledSupplyPct: { on: true, threshold: 20 },
    sniperTopHolderCount: { on: true, threshold: 2 },
    linkedWalletPct: { on: true, threshold: 25 },
    devWalletPct: { on: false, threshold: 5 },
    top10HolderPct: { on: false, threshold: 30 },
    freshTop10WalletPct: { on: false, threshold: 40 },
    cexFundedPct: { on: false, threshold: 40 },
    kolRecentBuyers: { on: false, threshold: null },
    mintAuthorityActive: { on: false, threshold: null },
  },
  sites: { axiom: true, terminal: true, gmgn: true },
  style: { ring: "halo", calmMotion: false },
};

/** How each flag reads in the tooltip and popup. */
export const FLAG_LABELS: Record<FlagId, { label: string; short: string; unit: "%" | "count" | "bool" }> = {
  bundledSupplyPct: { label: "Bundled supply", short: "BNDL", unit: "%" },
  sniperTopHolderCount: { label: "Snipers in top 10", short: "SNPR", unit: "count" },
  linkedWalletPct: { label: "Linked wallets", short: "LINK", unit: "%" },
  devWalletPct: { label: "Dev holding", short: "DEV", unit: "%" },
  top10HolderPct: { label: "Top 10 share", short: "TOP10", unit: "%" },
  freshTop10WalletPct: { label: "Fresh wallets in top 10", short: "FRESH", unit: "%" },
  cexFundedPct: { label: "CEX-funded holders", short: "CEX", unit: "%" },
  kolRecentBuyers: { label: "KOL buyers", short: "KOL", unit: "count" },
  mintAuthorityActive: { label: "Mint authority live", short: "MINT", unit: "bool" },
};

export { FLAG_IDS };
