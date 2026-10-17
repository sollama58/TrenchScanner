import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { fillPage, joinPages, nextDepth } from "./feedFill";

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
    const p = fillPage(buffer, on, 1, undefined, 3);
    expect(ids(p.shown)).toEqual(["a", "c", "d"]);
    expect(p.hiddenHere).toBe(1);
    expect(p.moreLoaded).toBe(true);
    expect(ids(fillPage(buffer, on, 2, undefined, 3).shown)).toEqual(["e"]);
  });

  it("puts a card back in its own place once it climbs over the line", () => {
    const buffer = [card("a", 9e3), card("b", 5e3), card("c", 8e3), card("d", 7e3)];
    expect(ids(fillPage(buffer, on, 1, undefined, 3).shown)).toEqual(["a", "b", "c"]);
  });

  it("keeps cards with no reading yet, and shows everything when off", () => {
    const buffer = [card("a", null), card("b", 1e3)];
    expect(ids(fillPage(buffer, on, 1, undefined, 3).shown)).toEqual(["a"]);
    expect(ids(fillPage(buffer, { ...on, hideBelowMcap: false }, 1, undefined, 3).shown)).toEqual(["a", "b"]);
  });

  it("ticks the page's cards first, then the hidden ones among them", () => {
    const buffer = [card("a", 1e3), card("b", 9e3), card("c", 9e3)];
    expect(fillPage(buffer, on, 1, undefined, 2).tickTokenIds).toEqual(["t-b", "t-c", "t-a"]);
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

describe("fillPage at the line", () => {
  it("keeps a hidden card hidden until it is back 10% over the line", () => {
    const at = (mcap: number) => [card("a", 9e3), card("b", mcap), card("c", 8e3)];
    const first = fillPage(at(4.9e3), on, 1, new Set(), 3);
    expect(first.hidden.has("b")).toBe(true);
    // Back just over the line: still hidden, no flicker.
    const second = fillPage(at(5.2e3), on, 1, first.hidden, 3);
    expect(ids(second.shown)).toEqual(["a", "c"]);
    // Clear of the margin: back in its own place.
    const third = fillPage(at(5.6e3), on, 1, second.hidden, 3);
    expect(ids(third.shown)).toEqual(["a", "b", "c"]);
    // And shown cards only hide once under the line itself.
    expect(ids(fillPage(at(5.1e3), on, 1, third.hidden, 3).shown)).toEqual(["a", "b", "c"]);
  });

  it("keeps the last call's choice for a card with no reading or past the page", () => {
    const buffer = [card("a", null), card("b", 9e3), card("c", 9e3), card("d", 1e3)];
    const p = fillPage(buffer, on, 1, new Set(["a", "d"]), 1);
    expect(ids(p.shown)).toEqual(["b"]);
    expect([...p.hidden].sort()).toEqual(["a", "d"]);
  });
});

describe("nextDepth", () => {
  it("reads as many pages as the short page looks to need, in one step", () => {
    // 4 shown from 1 page, 12 wanted: two more at that rate.
    expect(nextDepth(1, 4, 12, 15)).toBe(3);
    expect(nextDepth(3, 9, 12, 15)).toBe(4);
  });

  it("reads one more when full but not past it, doubles with nothing shown, and stops at the cap", () => {
    expect(nextDepth(2, 12, 12, 15)).toBe(3);
    expect(nextDepth(4, 0, 12, 15)).toBe(8);
    expect(nextDepth(10, 1, 12, 15)).toBe(15);
  });
});
