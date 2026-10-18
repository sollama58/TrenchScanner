import { describe, expect, it } from "vitest";
import { feeSummary, OTHER_PLATFORMS } from "./tradeFees.js";

const SOL = 1_000_000_000n;
const trade = (side: "buy" | "sell", sol: bigint, networkFeeLamports = 100_000n) => ({
  side,
  lamports: sol * SOL,
  platformFeeLamports: 0n,
  networkFeeLamports,
});

describe("feeSummary", () => {
  it("prices each platform's fee on the same trades, buys and sales at their own rates", () => {
    const s = feeSummary([trade("buy", 2n), trade("sell", 4n)]);
    expect(s).toMatchObject({
      trades: 2,
      buys: 1,
      sells: 1,
      volumeSol: 6,
      platformFeeSol: 0,
      networkFeeSol: 0.0002,
    });
    const by = Object.fromEntries(s.platforms.map((p) => [p.id, p.savedSol]));
    // 0.5% each way on 6 SOL; 0.35% on the 4 SOL sale only; 1% each way.
    expect(by).toEqual({ fomo: 0.03, pumpfun: 0.014, terminal: 0.03, axiom: 0.06 });
  });

  it("counts a platform fee we charged against the savings, and nothing for no trades", () => {
    const s = feeSummary([{ ...trade("buy", 1n), platformFeeLamports: 1_000_000n }]);
    expect(s.platforms.find((p) => p.id === "axiom")!.savedSol).toBe(0.009);
    expect(feeSummary([]).platforms.map((p) => p.savedSol)).toEqual(OTHER_PLATFORMS.map(() => 0));
  });
});
