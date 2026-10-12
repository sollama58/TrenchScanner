// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { Env } from "@trenchscanner/core";
import {
  callMcapUsd,
  dropBelowAlertFloor,
  newCuratedCycle,
  readLiveMarketCaps,
  resetDeferredContenders,
  takeContenderRetry,
  type CuratedContender,
} from "./curatedAlerts.js";

const contender = (
  mint: string,
  marketCapUsd: number,
  freshQuote?: { priceUsd: number; marketCapUsd: number },
): CuratedContender =>
  ({
    token: { id: `id-${mint}`, mintAddress: mint },
    scored: { priceUsd: 0.00001, marketCapUsd, freshQuote },
    cycleSample: null,
    decision: { curate: true, confidence: 50, reasons: [], source: "m" },
    confidence: 50,
  }) as unknown as CuratedContender;

describe("readLiveMarketCaps", () => {
  it("stamps every ledger's contender for a coin with one Pump.fun read", async () => {
    const cycle = newCuratedCycle();
    const a1 = contender("a", 20_000);
    const a2 = contender("a", 20_000);
    const b = contender("b", 30_000);
    cycle.byModel.set("m1", [a1, b]);
    cycle.byModel.set("m2", [a2]);
    const asked: string[] = [];
    await readLiveMarketCaps(cycle, async (mint) => {
      asked.push(mint);
      return mint === "a" ? 16_500 : null;
    });
    expect(asked.sort()).toEqual(["a", "b"]);
    expect([a1.liveMcapUsd, a2.liveMcapUsd, b.liveMcapUsd]).toEqual([16_500, 16_500, undefined]);
  });

  it("drops a reading far from the anchor, and survives a lookup that throws", async () => {
    const cycle = newCuratedCycle();
    const far = contender("far", 20_000);
    const broken = contender("broken", 20_000);
    cycle.byModel.set("m", [far, broken]);
    await readLiveMarketCaps(cycle, (mint) => {
      if (mint === "broken") throw new Error("boom");
      return Promise.resolve(200_000);
    });
    expect(far.liveMcapUsd).toBeUndefined();
    expect(broken.liveMcapUsd).toBeUndefined();
  });

  it("sends without a reading Pump.fun is slow to give", async () => {
    const cycle = newCuratedCycle();
    const slow = contender("slow", 20_000);
    cycle.byModel.set("m", [slow]);
    const startedAt = Date.now();
    await readLiveMarketCaps(cycle, () => new Promise(() => {}));
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(slow.liveMcapUsd).toBeUndefined();
  });
});

describe("the alert floor", () => {
  const env = { CURATED_ALERT_MIN_MCAP_USD: 7_500, CURATED_CONTENDER_RETRY_MINUTES: 15 } as Env;

  it("prices a call at the lowest current reading, not DexScreener's lagged one", () => {
    // DexScreener still reads $11k; the fresh quote says the coin is at $8k.
    const quoted = contender("q", 11_000, { priceUsd: 0.000008, marketCapUsd: 8_000 });
    expect(callMcapUsd(quoted)).toBe(8_000);
    quoted.liveMcapUsd = 7_200;
    expect(callMcapUsd(quoted)).toBe(7_200);
    // No fresh quote and no live read: the scan's figure is all there is.
    expect(callMcapUsd(contender("s", 12_000))).toBe(12_000);
  });

  it("drops a coin that has fallen under the floor, keeps the grace above it, and files a retry", () => {
    resetDeferredContenders();
    const cycle = newCuratedCycle();
    const fallen = contender("fallen", 10_500, { priceUsd: 0.0000069, marketCapUsd: 6_900 });
    const grace = contender("grace", 10_500, { priceUsd: 0.0000082, marketCapUsd: 8_200 });
    const liveLow = contender("live-low", 12_000);
    liveLow.liveMcapUsd = 7_000;
    cycle.byModel.set("m", [fallen, grace, liveLow]);
    dropBelowAlertFloor(cycle, env);
    expect(cycle.byModel.get("m")).toEqual([grace]);
    expect(takeContenderRetry("id-fallen")?.models).toEqual(["m"]);
    expect(takeContenderRetry("id-live-low")?.models).toEqual(["m"]);
    expect(takeContenderRetry("id-grace")).toBeNull();
  });
});
