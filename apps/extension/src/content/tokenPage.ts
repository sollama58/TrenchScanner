import { mintsIn } from "../shared/mint";
import type { Site } from "../shared/types";

/**
 * A coin's own page on each site (saved pages, 2026-10-25): Axiom's /meme/<pair> (and /t/<mint>),
 * Terminal's /trade/solana/<pair>, GMGN's /sol/token/<mint>. The path names a pool on Axiom and
 * Terminal, so the coin is read from the page.
 */
const TOKEN_PATHS: Record<Site, RegExp> = {
  axiom: /^\/(meme|t)\/[1-9A-HJ-NP-Za-km-z]{32,44}/,
  terminal: /^\/trade\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}/,
  gmgn: /^\/sol\/token\//,
};

export function isTokenPage(site: Site, path: string): boolean {
  return TOKEN_PATHS[site].test(path);
}

/** Where a page names its coin: its explorer and launchpad links, and Terminal's copy button. */
const MINT_SOURCES: [selector: string, attr: string][] = [
  ["a[href^='https://solscan.io/token/']", "href"],
  ["a[href^='https://pump.fun/coin/']", "href"],
  ["[id^='button-copy-address-context-']", "id"],
];

/**
 * The coin a token page shows: the address its links name most often (a trade list can name
 * other coins once or twice; the page's own header names its coin in several places). GMGN's
 * path is the mint itself.
 */
export function pageMint(root: ParentNode, site: Site, path: string): string | null {
  if (site === "gmgn") {
    const fromPath = mintsIn(path.split("/").pop()?.split("_").pop() ?? "")[0];
    if (fromPath) return fromPath;
  }
  const counts = new Map<string, number>();
  for (const [selector, attr] of MINT_SOURCES) {
    for (const el of root.querySelectorAll(selector)) {
      const mint = mintsIn(el.getAttribute(attr) ?? "")[0];
      if (mint) counts.set(mint, (counts.get(mint) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  for (const [mint, n] of counts) if (best === null || n > counts.get(best)!) best = mint;
  return best;
}

/** The site's tab strip under the chart (Trades, Positions, Holders, Top Traders…), or null. */
export function findTabStrip(root: Document): Element | null {
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() !== "Top Traders") continue;
    const tab = node.parentElement?.closest("button, [role='tab']");
    const strip = tab?.parentElement;
    if (strip && /Holders/.test(strip.textContent ?? "") && strip.children.length >= 3) return strip;
  }
  return null;
}
