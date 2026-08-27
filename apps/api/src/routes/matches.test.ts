import { describe, expect, it } from "vitest";
import { currentMarketCap } from "./matches.js";

const T = (isoMinutesAgo: number) => new Date(Date.now() - isoMinutesAgo * 60_000);

describe("currentMarketCap", () => {
  it("prefers the live ping when it's newer than the snapshot", () => {
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: T(1) },
      { marketCapUsd: 200_000, takenAt: T(6) },
    );
    expect(result.marketCapUsd).toBe(250_000);
  });

  it("prefers the snapshot when IT is the newer of the two", () => {
    // Happens for a token nobody has viewed recently: live pings stopped, but it's still in the
    // mcap band so the scan cycle keeps writing snapshots.
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: T(30) },
      { marketCapUsd: 200_000, takenAt: T(2) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("falls back to the snapshot when there's no live ping at all", () => {
    const result = currentMarketCap(
      { liveMarketCapUsd: null, liveDataAt: null },
      { marketCapUsd: 200_000, takenAt: T(3) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("uses the live ping when there's no snapshot at all", () => {
    const result = currentMarketCap({ liveMarketCapUsd: 250_000, liveDataAt: T(1) }, null);
    expect(result.marketCapUsd).toBe(250_000);
  });

  it("returns nulls when neither reading exists", () => {
    expect(currentMarketCap({ liveMarketCapUsd: null, liveDataAt: null }, null)).toEqual({
      marketCapUsd: null,
      at: null,
    });
  });

  it("ignores a live timestamp with no value attached", () => {
    // Defensive: liveDataAt set but liveMarketCapUsd null shouldn't win and yield a null figure.
    const result = currentMarketCap(
      { liveMarketCapUsd: null, liveDataAt: T(1) },
      { marketCapUsd: 200_000, takenAt: T(9) },
    );
    expect(result.marketCapUsd).toBe(200_000);
  });

  it("reports the timestamp belonging to whichever reading it chose", () => {
    const liveAt = T(1);
    const result = currentMarketCap(
      { liveMarketCapUsd: 250_000, liveDataAt: liveAt },
      { marketCapUsd: 200_000, takenAt: T(6) },
    );
    expect(result.at).toBe(liveAt);
  });
});
