import { mintsIn } from "../../shared/mint";
import type { Site } from "../../shared/types";

/**
 * How the engine finds token rows on one site. Kept to data where possible: when a site changes
 * its markup, the fix is usually a selector here.
 *
 * The selectors below are first guesses from each site's public URLs (our own quick links in
 * apps/web/src/appearance.ts use the same paths). They are to be checked against saved pages of
 * each signed-in board before the beta.
 */
export interface SiteAdapter {
  site: Site;
  /** The page's hostname is this site's. */
  matchesHost(host: string): boolean;
  /** Elements that hold exactly one token each, in document order. */
  findRows(root: ParentNode): Element[];
  /** The token address a row shows, or null when none can be read with certainty. */
  mintOf(row: Element): string | null;
}

export interface AdapterSpec {
  site: Site;
  hosts: RegExp;
  /** Links that open one token's page; the first capture group, if any, is where the mint sits. */
  tokenLink: RegExp;
  /**
   * The row around a token link: the nearest ancestor matching one of these. Virtualised lists
   * mark rows with data-index, which is tried after the site's own selectors.
   */
  rowSelectors: string[];
}

/** Attributes read for an address after the links: image URLs and data attributes. */
const SCANNED_ATTRIBUTES = ["src", "data-address", "data-mint", "data-token", "data-ca"];

export function mintInHref(href: string, tokenLink: RegExp): string | null {
  let path: string;
  try {
    path = new URL(href, "https://x.invalid").pathname;
  } catch {
    return null;
  }
  const match = tokenLink.exec(path);
  if (!match) return null;
  return mintsIn(match[1] ?? match[0])[0] ?? null;
}

export function adapterFrom(spec: AdapterSpec): SiteAdapter {
  const rowOf = (link: Element): Element | null => {
    for (const selector of [...spec.rowSelectors, "[data-index]"]) {
      const row = link.closest(selector);
      if (row) return row;
    }
    // A link that is itself the whole row (common on GMGN).
    return link;
  };

  return {
    site: spec.site,
    matchesHost: (host) => spec.hosts.test(host),
    findRows(root) {
      const rows: Element[] = [];
      const seen = new Set<Element>();
      for (const link of root.querySelectorAll("a[href]")) {
        if (mintInHref(link.getAttribute("href") ?? "", spec.tokenLink) === null) continue;
        const row = rowOf(link);
        if (row && !seen.has(row)) {
          seen.add(row);
          rows.push(row);
        }
      }
      return rows;
    },
    mintOf(row) {
      // Every distinct token link in the row must agree; two different mints mean this is a
      // container of rows, not a row, and nothing is drawn rather than the wrong thing.
      const found = new Set<string>();
      const links = row.matches("a[href]")
        ? [row, ...row.querySelectorAll("a[href]")]
        : [...row.querySelectorAll("a[href]")];
      for (const link of links) {
        const mint = mintInHref(link.getAttribute("href") ?? "", spec.tokenLink);
        if (mint) found.add(mint);
      }
      if (found.size === 1) return [...found][0]!;
      if (found.size > 1) return null;
      for (const el of [
        row,
        ...row.querySelectorAll("img, [data-address], [data-mint], [data-token], [data-ca]"),
      ]) {
        for (const name of SCANNED_ATTRIBUTES) {
          const value = el.getAttribute(name);
          const mint = value ? mintsIn(value)[0] : undefined;
          if (mint) return mint;
        }
      }
      return null;
    },
  };
}
