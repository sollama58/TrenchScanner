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
  it("adds other platforms' gas and priority fee per buy and sale, less our own, to the savings with the toggle on", () => {
    const s = feeSummary([trade("buy", 2n), trade("sell", 4n)]);
    expect(s.otherNetwork).toEqual({
      gasSol: 0.001,
      priorityFeeSol: 0.01,
      perTradeSol: 0.011,
      totalSol: 0.022,
    });
    const fomo = s.platforms.find((p) => p.id === "fomo")!;
    expect(fomo).toMatchObject({
      feeSol: 0.03,
      savedSol: 0.03,
      feeWithNetworkSol: 0.052,
      // 0.052 less the 0.0002 our two trades paid the network.
      savedWithNetworkSol: 0.0518,
    });
  });

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
    // 0.5%, 0.45% and 0.95% each way on 6 SOL.
    expect(by).toEqual({ fomo: 0.03, pumpfun: 0.027, terminal: 0.03, axiom: 0.057 });
  });

  it("counts a platform fee we charged against the savings, and nothing for no trades", () => {
    const s = feeSummary([{ ...trade("buy", 1n), platformFeeLamports: 1_000_000n }]);
    expect(s.platforms.find((p) => p.id === "axiom")!.savedSol).toBe(0.0085);
    expect(feeSummary([]).platforms.map((p) => p.savedSol)).toEqual(OTHER_PLATFORMS.map(() => 0));
  });
});
