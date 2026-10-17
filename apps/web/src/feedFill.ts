import type { Card, FeedAppearance } from "./api";
import { belowMcapLine } from "./components/AlertCard";

/** Cards on one Live feed page: the API's fixed page size. */
export const FEED_PAGE_SIZE = 12;

/**
 * How many API pages the Live feed may read for the page on screen: that page's own number plus
 * this many - 1, to fill in behind the cards hidden or folded away. Each is polled with the feed,
 * so this bounds what filling costs; past it a page may come up short.
 */
export const MAX_FILL_PAGES = 15;

/** The most API pages the Live feed reads at all, however far back it is paged. */
export const MAX_READ_PAGES = 40;

/** The live tick's limit on tokens per request (LIVE_TICK_MAX_TOKENS in the API). */
const MAX_TICK_TOKENS = 30;

export interface FilledPage {
  /** The cards to draw on this page, in feed order. */
  shown: Card[];
  /** Alerts hidden ahead of or among this page's cards. */
  hiddenHere: number;
  /** Whether the cards read so far hold a shown card past this page (so it is full, with an older one). */
  moreLoaded: boolean;
  /** Shown cards counted in the alerts read so far, up to and including this page's (for nextDepth). */
  visible: number;
  /**
   * Tokens to keep "Now" seconds old: this page's cards first, then the hidden ones among them,
   * which come back once they climb over the line. Within the live tick's limit.
   */
  tickTokenIds: string[];
  /** The alerts hidden now: pass it back as `wasHidden` next time, so hiding holds steady at the line. */
  hidden: ReadonlySet<string>;
}

/**
 * One page of the Live feed with the "hide below this market cap" cards taken out and later ones
 * moved up in their place, from the alerts read so far (`buffer`, newest first). A hidden card
 * that climbs back over the line (with MCAP_RESHOW_MARGIN to spare) takes its own place again,
 * pushing the rest back down. `wasHidden` is the last call's `hidden`.
 */
export function fillPage(
  buffer: readonly Card[],
  look: Pick<FeedAppearance, "hideBelowMcap" | "hideBelowMcapUsd">,
  page: number,
  wasHidden: ReadonlySet<string> = new Set(),
  pageSize = FEED_PAGE_SIZE,
): FilledPage {
  const start = (page - 1) * pageSize;
  const end = page * pageSize;
  const shown: Card[] = [];
  const hiddenIds: string[] = [];
  let visible = 0;
  let moreLoaded = false;
  const hiddenNow = new Set<string>();
  let read = 0;
  for (const card of buffer) {
    const hidden = belowMcapLine(card, look, wasHidden.has(card.id));
    if (hidden) hiddenNow.add(card.id);
    read++;
    if (!hidden) {
      if (visible >= end) {
        moreLoaded = true;
        break;
      }
      if (visible >= start) shown.push(card);
      visible++;
    } else if (visible >= start && visible < end) {
      // Hidden ahead of or among this page's cards.
      hiddenIds.push(card.tokenId);
    }
  }
  // Cards past this page weren't looked at: they keep what they were.
  for (const card of buffer.slice(read)) if (wasHidden.has(card.id)) hiddenNow.add(card.id);
  const tickTokenIds = [...new Set([...shown.map((c) => c.tokenId), ...hiddenIds])].slice(0, MAX_TICK_TOKENS);
  return { shown, hiddenHere: hiddenIds.length, moreLoaded, visible, tickTokenIds, hidden: hiddenNow };
}

/** The feed's pages read so far as one list, newest first, each alert once. */
export function joinPages(pages: readonly ({ matches: Card[] } | null)[]): Card[] {
  const seen = new Set<string>();
  const out: Card[] = [];
  for (const p of pages) {
    // A page still loading ends the run: cards past a gap would sit out of order.
    if (!p) break;
    for (const c of p.matches) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * How many API pages to read next when the `depth` read so far hold only `visible` shown cards and
 * the page on screen needs `want`: enough more at the rate the pages read so far showed cards, in
 * one step rather than one page per round trip, which made a short page fill in a few cards at a
 * time. With nothing shown yet it doubles. Never more than `maxDepth`.
 */
export function nextDepth(depth: number, visible: number, want: number, maxDepth: number): number {
  const more = visible === 0 ? depth : Math.ceil(((want - visible) * depth) / visible);
  return Math.min(maxDepth, depth + Math.max(1, more));
}
