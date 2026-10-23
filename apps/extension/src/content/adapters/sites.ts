import { adapterFrom, type SiteAdapter } from "./adapter";

/** Axiom: Pulse columns. Token pages are /t/<mint>; /meme/<pair> links name a pool, not a mint. */
export const axiom = adapterFrom({
  site: "axiom",
  hosts: /(^|\.)axiom\.trade$/,
  tokenLink: /^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  rowSelectors: ["[data-pair-address]", "[class*='pulse'] [class*='row']"],
});

/** Terminal (formerly Padre): the Trenches board. Token pages are /trade/solana/<mint>. */
export const terminal = adapterFrom({
  site: "terminal",
  hosts: /(^|\.)padre\.gg$/,
  tokenLink: /^\/trade\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  rowSelectors: ["[class*='TokenRow']", "[class*='token-row']"],
});

/** GMGN: trenches and trending lists. Token pages are /sol/token/<mint>, sometimes as <ref>_<mint>. */
export const gmgn = adapterFrom({
  site: "gmgn",
  hosts: /(^|\.)gmgn\.ai$/,
  tokenLink: /^\/sol\/token\/(?:[A-Za-z0-9]+_)?([1-9A-HJ-NP-Za-km-z]{32,44})/,
  rowSelectors: ["[class*='TokenRow']", "[class*='token-row']"],
});

export const ADAPTERS: SiteAdapter[] = [axiom, terminal, gmgn];

export function adapterForHost(host: string): SiteAdapter | null {
  return ADAPTERS.find((a) => a.matchesHost(host)) ?? null;
}
