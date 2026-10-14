import type { Card, FeedAppearance } from "./api";
import { belowMcapLine } from "./components/AlertCard";

/** Cards on one Live feed page: the API's fixed page size. */
export const FEED_PAGE_SIZE = 12;

/**
 * The most API pages the Live feed reads ahead to keep a page full while low market caps are
 * hidden. Each is polled with the feed, so this bounds what hiding costs; past it a page may come
 * up short.
 */
export const MAX_FILL_PAGES = 15;

/** The live tick's limit on tokens per request (LIVE_TICK_MAX_TOKENS in the API). */
const MAX_TICK_TOKENS = 30;

export interface FilledPage {
  /** The cards to draw on this page, in feed order. */
  shown: Card[];
  /** Alerts hidden ahead of or among this page's cards. */
  hiddenHere: number;
  /** Whether the cards read so far hold a shown card past this page (so it is full, with an older one). */
  moreLoaded: boolean;
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
  return { shown, hiddenHere: hiddenIds.length, moreLoaded, tickTokenIds, hidden: hiddenNow };
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
