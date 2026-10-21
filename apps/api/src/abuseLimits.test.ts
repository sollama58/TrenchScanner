import { describe, expect, it } from "vitest";
import {
  allowHolderWatch,
  allowViewStamps,
  clearHolderWatchWindows,
  clearViewStampWindows,
  HOLDER_WATCHES_PER_USER,
} from "./routes/live.js";
import { allowTextSearch } from "./routes/matches.js";
import { ipRateLimitKey } from "./clientIp.js";

/** The per-account abuse limits added by the 2026-10-16 security audit. */
describe("view stamps per account", () => {
  it("caps the distinct tokens one account marks viewed per window, and re-stamps what it already has", () => {
    clearViewStampWindows();
    const t0 = 1_000_000;
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `t${from + i}`);
    expect(allowViewStamps("u1", ids(0, 100), t0)).toHaveLength(100);
    // 20 more fit under the cap of 120, the rest of this batch is refused.
    expect(allowViewStamps("u1", ids(100, 30), t0 + 1)).toHaveLength(20);
    // Already-stamped ids keep stamping.
    expect(allowViewStamps("u1", ids(0, 30), t0 + 2)).toHaveLength(30);
    // Another account is unaffected.
    expect(allowViewStamps("u2", ids(500, 30), t0 + 3)).toHaveLength(30);
    // A new window starts over.
    expect(allowViewStamps("u1", ids(900, 30), t0 + 6 * 60_000)).toHaveLength(30);
  });
});

describe("bubble map watches per account", () => {
  it("keeps the four newest maps, and releases the oldest when a fifth is opened", () => {
    clearHolderWatchWindows();
    const t0 = 7_000_000;
    const mints = ["a", "b", "c", "d", "e"];
    for (const mint of mints.slice(0, HOLDER_WATCHES_PER_USER)) {
      expect(allowHolderWatch("u", mint, t0)).toEqual({ stamp: true, released: [] });
    }
    // 2026-10-21 user ask: the fifth is stamped, and the oldest stamp is the one to clear.
    expect(allowHolderWatch("u", "e", t0 + 1)).toEqual({
      stamp: true,
      released: [{ mint: "a", at: t0 }],
    });
    // Re-polling a map still held makes it the newest, so the next new map releases the next oldest.
    expect(allowHolderWatch("u", "b", t0 + 30_000)).toEqual({ stamp: true, released: [] });
    expect(allowHolderWatch("u", "f", t0 + 30_001)).toEqual({
      stamp: true,
      released: [{ mint: "c", at: t0 }],
    });
  });

  it("does not release a map another account still holds, and does release one the window outlived", () => {
    clearHolderWatchWindows();
    const t0 = 8_000_000;
    expect(allowHolderWatch("u", "a", t0).released).toEqual([]);
    expect(allowHolderWatch("other", "a", t0).released).toEqual([]);
    expect(allowHolderWatch("u", "b", t0 + 1).released).toEqual([]);
    expect(allowHolderWatch("u", "c", t0 + 2).released).toEqual([]);
    expect(allowHolderWatch("u", "d", t0 + 3).released).toEqual([]);
    // "a" is u's oldest, but other still has it, so nothing is cleared.
    expect(allowHolderWatch("u", "e", t0 + 4).released).toEqual([]);
    // Past the window, u's maps age out. "a" is still other's, so only u's others are released.
    const aged = allowHolderWatch("u", "z", t0 + 2 * 60_000 + 10);
    expect(aged.stamp).toBe(true);
    expect(aged.released.map((row) => row.mint).sort()).toEqual(["b", "c", "d", "e"]);
    // The same call that reopens an expired map does not release it.
    expect(allowHolderWatch("solo", "a", t0).released).toEqual([]);
    expect(allowHolderWatch("solo", "a", t0 + 2 * 60_000 + 10).released).toEqual([]);
  });
});

describe("text search budget", () => {
  it("allows 30 searches a minute per account, mint lookups included", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 30; i++) expect(allowTextSearch("searcher", t0 + i)).toBe(true);
    expect(allowTextSearch("searcher", t0 + 31)).toBe(false);
    expect(allowTextSearch("someone-else", t0 + 31)).toBe(true);
    expect(allowTextSearch("searcher", t0 + 61_000)).toBe(true);
  });
});

describe("ipRateLimitKey", () => {
  it("keys by the client address whatever session the request carries", () => {
    const request = {
      headers: { "cf-connecting-ip": "203.0.113.7", authorization: "Bearer anything" },
      ip: "10.0.0.1",
    } as never;
    expect(ipRateLimitKey(request)).toBe("ip:203.0.113.7");
  });
});
