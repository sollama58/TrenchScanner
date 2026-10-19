import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import {
  dueToUnhide,
  hiddenEntry,
  multipleReached,
  normalizeHiddenTokens,
  unhideReason,
} from "./hiddenTokens";

/** A filter alert at `alertMcap`, now at `nowMcap`, with its recorded peak. */
function card(
  id: string,
  tokenId: string,
  alertMcap: number,
  nowMcap: number | null,
  peakPct: number | null = null,
  graduated = false,
): Card {
  return {
    id,
    kind: "match",
    tokenId,
    matchedAt: "2026-10-19T00:00:00Z",
    peakReturnPct: peakPct,
    token: { id: tokenId, mintAddress: `mint-${tokenId}`, symbol: "FOO", name: "Foo", imageUrl: null },
    snapshot: { marketCapUsd: alertMcap, graduated },
    latestSnapshot: null,
    currentMarketCapUsd: nowMcap,
    filter: null,
    curated: null,
  } as unknown as Card;
}

describe("multipleReached", () => {
  it("names the highest of 2x, 4x and 10x reached", () => {
    expect(multipleReached(1.9)).toBe(0);
    expect(multipleReached(2)).toBe(2);
    expect(multipleReached(5)).toBe(4);
    expect(multipleReached(12)).toBe(10);
  });
});

describe("auto-unhide", () => {
  it("brings a token back when it first passes 2x from the alert it was hidden on", () => {
    const entry = hiddenEntry(card("a", "t", 10_000, 12_000));
    expect(entry.reachedX).toBe(0);
    expect(unhideReason(entry, [card("a", "t", 10_000, 15_000)])).toBeNull();
    expect(unhideReason(entry, [card("a", "t", 10_000, 21_000)])).toBe("hit 2x");
  });

  it("counts the recorded peak, not only the market cap now", () => {
    const entry = hiddenEntry(card("a", "t", 10_000, 12_000));
    expect(unhideReason(entry, [card("a", "t", 10_000, 9_000, 120)])).toBe("hit 2x");
  });

  it("waits for 4x when it had already passed 2x, and 10x after 4x", () => {
    const at2 = hiddenEntry(card("a", "t", 10_000, 25_000, 150));
    expect(at2.reachedX).toBe(2);
    expect(unhideReason(at2, [card("a", "t", 10_000, 30_000, 150)])).toBeNull();
    expect(unhideReason(at2, [card("a", "t", 10_000, 41_000, 150)])).toBe("hit 4x");
    const at4 = hiddenEntry(card("a", "t", 10_000, 50_000));
    expect(unhideReason(at4, [card("a", "t", 10_000, 90_000)])).toBeNull();
    expect(unhideReason(at4, [card("a", "t", 10_000, 100_000)])).toBe("hit 10x");
  });

  it("brings a token back when it graduates, unless it had already", () => {
    const entry = hiddenEntry(card("a", "t", 10_000, 12_000));
    expect(unhideReason(entry, [card("a", "t", 10_000, 12_000, null, true)])).toBe("graduated");
    expect(unhideReason(entry, [card("a", "t", 10_000, 12_000)], new Set(["t"]))).toBe("graduated");
    const grad = hiddenEntry(card("a", "t", 10_000, 12_000, null, true));
    expect(unhideReason(grad, [card("a", "t", 10_000, 12_000, null, true)])).toBeNull();
  });

  it("takes the token's other alerts' runs as already reached when hiding", () => {
    const older = card("old", "t", 4_000, 12_000);
    const entry = hiddenEntry(card("new", "t", 10_000, 12_000), [older]);
    expect(entry.reachedX).toBe(0);
    // The older alert's own 3x is only 1.2x of the alert it was hidden on.
    expect(unhideReason(entry, [older, card("new", "t", 10_000, 12_000)])).toBeNull();
  });

  it("does nothing with auto-unhide off, and only for hidden tokens on screen", () => {
    const entry = hiddenEntry(card("a", "t", 10_000, 12_000));
    const ran = [card("a", "t", 10_000, 30_000), card("b", "u", 10_000, 30_000)];
    expect(dueToUnhide({ autoUnhide: true, tokens: [entry] }, ran)).toEqual(["t"]);
    expect(dueToUnhide({ autoUnhide: false, tokens: [entry] }, ran)).toEqual([]);
    expect(dueToUnhide({ autoUnhide: true, tokens: [entry] }, [ran[1]!])).toEqual([]);
  });
});

describe("normalizeHiddenTokens", () => {
  it("defaults to auto-unhide on and drops unreadable or repeated entries", () => {
    expect(normalizeHiddenTokens(null)).toEqual({ autoUnhide: true, tokens: [] });
    const good = hiddenEntry(card("a", "t", 10_000, 12_000));
    const out = normalizeHiddenTokens({
      autoUnhide: false,
      tokens: [good, { tokenId: "x" }, { ...good, symbol: "DUP" }, "junk"],
    });
    expect(out.autoUnhide).toBe(false);
    expect(out.tokens).toEqual([good]);
  });
});
