import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { fillPage, joinPages } from "./feedFill";

/** A filter alert priced from its snapshot, so "Now" is just its current market cap. */
const card = (id: string, mcap: number | null): Card =>
  ({
    id,
    tokenId: `t-${id}`,
    kind: "match",
    currentMarketCapUsd: mcap,
    matchedAt: "2026-10-14T00:00:00Z",
  }) as Card;
const on = { hideBelowMcap: true, hideBelowMcapUsd: 5_000 };
const ids = (cards: Card[]) => cards.map((c) => c.id);

describe("fillPage", () => {
  it("moves later alerts up into the places of hidden ones", () => {
    const buffer = [card("a", 9e3), card("b", 2e3), card("c", 8e3), card("d", 7e3), card("e", 6e3)];
    const p = fillPage(buffer, on, 1, 3);
    expect(ids(p.shown)).toEqual(["a", "c", "d"]);
    expect(p.hiddenHere).toBe(1);
    expect(p.moreLoaded).toBe(true);
    expect(ids(fillPage(buffer, on, 2, 3).shown)).toEqual(["e"]);
  });

  it("puts a card back in its own place once it climbs over the line", () => {
    const buffer = [card("a", 9e3), card("b", 5e3), card("c", 8e3), card("d", 7e3)];
    expect(ids(fillPage(buffer, on, 1, 3).shown)).toEqual(["a", "b", "c"]);
  });

  it("keeps cards with no reading yet, and shows everything when off", () => {
    const buffer = [card("a", null), card("b", 1e3)];
    expect(ids(fillPage(buffer, on, 1, 3).shown)).toEqual(["a"]);
    expect(ids(fillPage(buffer, { ...on, hideBelowMcap: false }, 1, 3).shown)).toEqual(["a", "b"]);
  });

  it("ticks the page's cards first, then the hidden ones among them", () => {
    const buffer = [card("a", 1e3), card("b", 9e3), card("c", 9e3)];
    expect(fillPage(buffer, on, 1, 2).tickTokenIds).toEqual(["t-b", "t-c", "t-a"]);
  });
});

describe("joinPages", () => {
  it("drops repeats and stops at a page still loading", () => {
    const pages = [
      { matches: [card("a", 1), card("b", 1)] },
      { matches: [card("b", 1), card("c", 1)] },
      null,
      { matches: [card("z", 1)] },
    ];
    expect(ids(joinPages(pages))).toEqual(["a", "b", "c"]);
  });
});
