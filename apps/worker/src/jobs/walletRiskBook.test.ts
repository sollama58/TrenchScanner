import { describe, expect, it } from "vitest";
import { withWalletSignals } from "./scanJob.js";
import { setWalletRiskBook, walletRiskLookup } from "./walletRiskBook.js";

describe("wallet risk readings on the scan", () => {
  const profile = {
    mintAddress: "M",
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    top10HolderAddresses: ["risky", "calm"],
    topHolderShares: [
      { owner: "risky", pct: 8 },
      { owner: "calm", pct: 3 },
    ],
  };
  const env = { WALLET_HOLDINGS_MIN_USD: 25 };

  it("records nothing before the scores load", () => {
    expect(walletRiskLookup()).toBeUndefined();
    expect(
      withWalletSignals(profile, new Map(), new Map(), env, undefined)?.walletRiskTop10Max,
    ).toBeUndefined();
  });

  it("reads the top holders and first buyers against the scores", () => {
    setWalletRiskBook([
      ["risky", { score: 85, dumps: 3 }],
      ["calm", { score: 20, dumps: 0 }],
    ]);
    const out = withWalletSignals(profile, new Map(), new Map(), env, new Set(["risky", "unknown"]));
    expect(out).toMatchObject({
      walletRiskTop10Max: 85,
      walletRiskFirstBuyersMean: 85,
      walletRiskHighSupplyPct: 8,
      knownDumperFirstBuyers: 1,
    });
  });
});
