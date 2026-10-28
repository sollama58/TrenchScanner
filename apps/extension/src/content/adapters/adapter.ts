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
  /** The row is marked as a board column's (Axiom's Pulse, Terminal's Trenches), wherever it sits. */
  inColumn(row: Element): boolean;
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
  /** Rows the site marks with the address, tried before the links. */
  marked?: Mark[];
  /**
   * Links elsewhere that name a row's own coin (pump.fun's coin page), matched against the whole
   * address; the first capture group is the mint. For boards whose rows don't link the site's own
   * token page.
   */
  coinLinks?: RegExp[];
  /** Links inside these are another coin's (a pair's quote token, a dev's earlier coin), never the row's. */
  ignoreLinksIn?: string;
}

/**
 * A row the site marks with the address (Terminal's `data-trenches-item="SOLANA:<mint>-NEW"`).
 * `selector` finds the marked element (by default any with `attr`); `box` is the nearest ancestor
 * to ring, when the mark sits inside a sized row (a virtual list's slot).
 */
export interface Mark {
  attr: string;
  selector?: string;
  box?: string;
  /** Only a board column's rows carry this mark (Terminal's copy button, say, sits on every coin). */
  column?: boolean;
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

/** The mint a full link names, by the first of `patterns` it matches. */
function mintInUrl(href: string, patterns: readonly RegExp[]): string | null {
  let url: string;
  try {
    url = new URL(href, "https://x.invalid").href;
  } catch {
    return null;
  }
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match) return mintsIn(match[1] ?? match[0])[0] ?? null;
  }
  return null;
}

export function adapterFrom(spec: AdapterSpec): SiteAdapter {
  const marks = (spec.marked ?? []).map((m) => ({ ...m, selector: m.selector ?? `[${m.attr}]` }));
  const anyMark = marks.map((m) => m.selector).join(", ");
  const columnMark = marks
    .filter((m) => m.column)
    .map((m) => m.selector)
    .join(", ");
  const rowOf = (link: Element): Element | null => {
    for (const selector of [...spec.rowSelectors, "[data-index]"]) {
      const row = link.closest(selector);
      if (row) return row;
    }
    // A link that is itself the whole row (common on GMGN).
    return link;
  };
  /** The mint a link names: the site's own token page, or one of the coin links. */
  const linkMint = (link: Element): string | null => {
    if (spec.ignoreLinksIn && link.closest(spec.ignoreLinksIn)) return null;
    const href = link.getAttribute("href") ?? "";
    return mintInHref(href, spec.tokenLink) ?? (spec.coinLinks ? mintInUrl(href, spec.coinLinks) : null);
  };
  /** The link sits in a marked row (or is around one): the mark speaks for the row. */
  const inMarkedRow = (el: Element): boolean => {
    if (!anyMark) return false;
    if (el.closest(anyMark) || el.querySelector(anyMark)) return true;
    return marks.some((m) => m.box && el.closest(m.box)?.querySelector(m.selector));
  };

  return {
    site: spec.site,
    matchesHost: (host) => spec.hosts.test(host),
    findRows(root) {
      const rows: Element[] = [];
      const seen = new Set<Element>();
      const add = (row: Element) => {
        if (!seen.has(row)) {
          seen.add(row);
          rows.push(row);
        }
      };
      for (const mark of marks) {
        for (const el of root.querySelectorAll(mark.selector)) {
          add((mark.box ? el.closest(mark.box) : null) ?? el);
        }
      }
      for (const link of root.querySelectorAll("a[href]")) {
        if (linkMint(link) === null) continue;
        const row = rowOf(link);
        // A marked row already stands for the links inside it, and a box around marked rows is a list.
        if (row && !inMarkedRow(row) && !inMarkedRow(link)) add(row);
      }
      return rows;
    },
    mintOf(row) {
      for (const mark of marks) {
        const el = row.matches(mark.selector) ? row : row.querySelector(mark.selector);
        // A marked row is read from its mark alone: another chain's row (an 0x address) stays bare
        // rather than taking an address from its pictures.
        if (el) return mintsIn(el.getAttribute(mark.attr) ?? "")[0] ?? null;
      }
      // Every distinct token link in the row must agree; two different mints mean this is a
      // container of rows, not a row, and nothing is drawn rather than the wrong thing.
      const found = new Set<string>();
      const links = row.matches("a[href]")
        ? [row, ...row.querySelectorAll("a[href]")]
        : [...row.querySelectorAll("a[href]")];
      for (const link of links) {
        const mint = linkMint(link);
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
          // An inline picture's bytes can spell a valid-looking address by chance.
          if (value?.startsWith("data:")) continue;
          const mint = value ? mintsIn(value)[0] : undefined;
          if (mint) return mint;
        }
      }
      return null;
    },
    inColumn(row) {
      return !!columnMark && (row.matches(columnMark) || !!row.querySelector(columnMark));
    },
  };
}
