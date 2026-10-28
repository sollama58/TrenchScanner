import { adapterFrom, type SiteAdapter } from "./adapter";

/** A coin's pump.fun page, and the OTC desk listing Axiom links beside it. */
const PUMP_LINKS = [
  /^https:\/\/pump\.fun\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  /^https:\/\/otcdesks\.cash\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
];
/** A virtual list's sized slot (Terminal's boards): the row to ring. */
const SLOT = "div[style*='position: absolute']";

/** Axiom: Pulse columns. Token pages are /t/<mint>; /meme/<pair> links name a pool, not a mint. */
export const axiom = adapterFrom({
  site: "axiom",
  hosts: /(^|\.)axiom\.trade$/,
  tokenLink: /^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  rowSelectors: ["[data-pair-address]"],
  // Pulse rows carry the token's address (a saved page, 2026-10-25); other chains' rows hold an
  // 0x address, which never reads as a mint, so they're left alone.
  marked: [{ attr: "data-pulse-token-address", column: true }],
  // Discover rows (a saved page, 2026-10-25) link the coin on pump.fun or otcdesks; their own /t/
  // link is the quote token's chip (its picture in a tooltip), another coin.
  coinLinks: PUMP_LINKS,
  ignoreLinksIn: "[data-discover-icon-row] [data-tooltip-trigger]",
});

/** Terminal (formerly Padre): the Trenches board. Token pages are /trade/solana/<mint>. */
export const terminal = adapterFrom({
  site: "terminal",
  hosts: /(^|\.)padre\.gg$/,
  tokenLink: /^\/trade\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
  rowSelectors: ["[class*='TokenRow']", "[class*='token-row']"],
  // The Trenches board marks each row, and its virtual list sizes the slot around it (a saved
  // page, 2026-10-25): no row links to the token's page.
  // Trending rows (a saved page, 2026-10-25) carry the address on their copy button; their
  // /trade/solana/ link is the quote pill, another coin.
  marked: [
    { attr: "data-trenches-item", box: SLOT, column: true },
    { attr: "id", selector: "[id^='button-copy-address-context-']", box: SLOT },
  ],
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
