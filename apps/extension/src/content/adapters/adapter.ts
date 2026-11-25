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
  /**
   * The attributes an address is read from: a virtual list that recycles a row for another coin
   * changes one of these, so a change to one calls for a scan, where a text change doesn't.
   */
  watchedAttributes: string[];
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

/**
 * A box that is a whole list or menu rather than one coin's row: one holding a search box, or a
 * layer by its role. A marked row's box never grows into one of these.
 *
 * Only a search box counts (by its type, role or label), not any input: Terminal's Trenches rows
 * hold a quick-buy amount field, and with every input counted (0.9.7) each row's slot was turned
 * down, its two marks (the row's and its copy button's) each climbed to a different box, and the
 * coin was ringed twice, one ring inside the other, each with its own pill and safety mark (user
 * report 2026-11-24). findRows also drops a row inside another row of the same coin.
 */
const NOT_A_ROW = [
  "input[type='search']",
  "input[placeholder*='search' i]",
  "input[aria-label*='search' i]",
  "[role='searchbox']",
  "[role='combobox']",
  "textarea",
  "[role='dialog']",
  "[role='listbox']",
  "[role='menu']",
  "[aria-modal='true']",
].join(", ");
/** How far above its mark a row's box is looked for, when the site gives no sized slot. */
const MAX_CLIMB = 8;

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

/**
 * The rows left once a row inside another row of the same coin is dropped: one coin, one ring. Two
 * marks, or a mark and a link, can each stand for a different box of one card (user report
 * 2026-11-24: Terminal's cards ringed twice, a pill on each). A row inside a box of another coin,
 * or of none (a list), is kept. Order is kept.
 */
export function outermost(rows: Element[], mintOf: (row: Element) => string | null): Element[] {
  if (rows.length < 2) return rows;
  const found = new Set(rows);
  const mints = new Map<Element, string | null>();
  const mint = (row: Element) => {
    if (!mints.has(row)) mints.set(row, mintOf(row));
    return mints.get(row)!;
  };
  return rows.filter((row) => {
    for (let up = row.parentElement; up; up = up.parentElement) {
      if (found.has(up) && mint(up) !== null && mint(up) === mint(row)) return false;
    }
    return true;
  });
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
  /** The distinct coins the marks in a box name (another chain's address names none), stopping at two. */
  const coinsIn = (box: Element): number => {
    const found = new Set<string>();
    for (const mark of marks) {
      const els = box.matches(mark.selector) ? [box] : [];
      for (const el of [...els, ...box.querySelectorAll(mark.selector)]) {
        const mint = mintsIn(el.getAttribute(mark.attr) ?? "")[0];
        if (mint) found.add(mint);
        if (found.size > 1) return found.size;
      }
    }
    return found.size;
  };
  /** A box is one coin's row: it names one coin and holds no search box or menu. */
  const oneCoin = (box: Element): boolean =>
    coinsIn(box) <= 1 && !box.matches(NOT_A_ROW) && !box.querySelector(NOT_A_ROW);
  /**
   * The row a marked element stands for: the mark's sized slot when that holds this coin alone,
   * else the widest box around the mark that still holds only this coin. A search menu that sits
   * in one absolutely placed box with every result's copy button (Terminal, user ask 2026-11-21)
   * was read as one row and its whole panel marked unsafe; now each result is its own row.
   */
  const markedRow = (el: Element, mark: (typeof marks)[number]): Element => {
    if (!mark.box) return el;
    const box = el.closest(mark.box);
    if (box && oneCoin(box)) return box;
    let row = el;
    for (let i = 0, up = el.parentElement; i < MAX_CLIMB && up && up !== box; i++, up = up.parentElement) {
      if (up === up.ownerDocument.body || !oneCoin(up)) break;
      row = up;
    }
    return row;
  };
  /** The rows found from marks this scan, which stand for every link inside them. */
  let markedRows = new Set<Element>();
  /** The link sits in a marked row (or is around one): the mark speaks for the row. */
  const inMarkedRow = (el: Element): boolean => {
    if (!anyMark) return false;
    if (el.closest(anyMark) || el.querySelector(anyMark)) return true;
    for (let a: Element | null = el; a; a = a.parentElement) if (markedRows.has(a)) return true;
    return false;
  };

  const adapter: SiteAdapter = {
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
      markedRows = new Set();
      for (const mark of marks) {
        for (const el of root.querySelectorAll(mark.selector)) {
          const row = markedRow(el, mark);
          markedRows.add(row);
          add(row);
        }
      }
      for (const link of root.querySelectorAll("a[href]")) {
        if (linkMint(link) === null) continue;
        const row = rowOf(link);
        // A marked row already stands for the links inside it, and a box around marked rows is a list.
        if (row && !inMarkedRow(row) && !inMarkedRow(link)) add(row);
      }
      return outermost(rows, (row) => adapter.mintOf(row));
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
    watchedAttributes: [...new Set(["href", ...SCANNED_ATTRIBUTES, ...marks.map((m) => m.attr)])],
  };
  return adapter;
}
