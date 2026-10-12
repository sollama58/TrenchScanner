// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { newCuratedCycle, readLiveMarketCaps, type CuratedContender } from "./curatedAlerts.js";

const contender = (mint: string, marketCapUsd: number): CuratedContender =>
  ({
    token: { id: `id-${mint}`, mintAddress: mint },
    scored: { marketCapUsd },
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
