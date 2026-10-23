import { describe, expect, it } from "vitest";
import { pctChange, readingOf, toEntry } from "./watchlist.js";

const at = (iso: string) => new Date(iso);

describe("pctChange", () => {
  it("measures from a positive base", () => {
    expect(pctChange(100, 150)).toBeCloseTo(50);
    expect(pctChange(200, 100)).toBeCloseTo(-50);
  });
  it("gives null without both figures or a positive base", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(0, 100)).toBeNull();
    expect(pctChange(100, Number.NaN)).toBeNull();
  });
});

describe("readingOf", () => {
  const snap = {
    tokenId: "t1",
    takenAt: at("2026-10-23T10:00:00Z"),
    marketCapUsd: 50_000,
    priceUsd: 0.00005,
    priceChange1hPct: 12.5,
  };

  it("takes the live price when it is the newer reading", () => {
    const r = readingOf(
      { liveMarketCapUsd: 60_000, livePriceUsd: 0.00006, liveDataAt: at("2026-10-23T10:05:00Z") },
      snap,
    );
    expect(r).toMatchObject({ marketCapUsd: 60_000, priceUsd: 0.00006, priceChange1hPct: 12.5 });
    expect(r.at?.toISOString()).toBe("2026-10-23T10:05:00.000Z");
    expect(r.changeAt?.toISOString()).toBe("2026-10-23T10:00:00.000Z");
  });

  it("takes the snapshot when the live reading is older or missing", () => {
    const older = readingOf(
      { liveMarketCapUsd: 60_000, livePriceUsd: 0.00006, liveDataAt: at("2026-10-23T09:00:00Z") },
      snap,
    );
    expect(older).toMatchObject({ marketCapUsd: 50_000, priceUsd: 0.00005 });
    const none = readingOf({ liveMarketCapUsd: null, livePriceUsd: null, liveDataAt: null }, null);
    expect(none).toEqual({
      marketCapUsd: null,
      priceUsd: null,
      at: null,
      priceChange1hPct: null,
      changeAt: null,
    });
  });
});

describe("toEntry", () => {
  it("serializes a starred token with its change since added", () => {
    const e = toEntry(
      {
        tokenId: "t1",
        addedAt: at("2026-10-23T09:00:00Z"),
        addedMarketCapUsd: 40_000,
        addedPriceUsd: 0.00004,
        token: { mintAddress: "Mint111", symbol: "PEPE", name: "Pepe", imageUrl: "http://insecure/x.png" },
      },
      {
        marketCapUsd: 50_000,
        priceUsd: 0.00005,
        at: at("2026-10-23T10:00:00Z"),
        priceChange1hPct: -3,
        changeAt: at("2026-10-23T10:00:00Z"),
      },
    );
    expect(e).toMatchObject({
      tokenId: "t1",
      mint: "Mint111",
      symbol: "PEPE",
      // Only https images reach the page.
      imageUrl: null,
      addedAt: "2026-10-23T09:00:00.000Z",
      marketCapUsd: 50_000,
      priceChange1hPct: -3,
    });
    expect(e.changeSinceAddedPct).toBeCloseTo(25);
  });
});
