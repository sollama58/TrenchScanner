import { describe, expect, it } from "vitest";
import { allowViewStamps, clearViewStampWindows } from "./routes/live.js";
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
