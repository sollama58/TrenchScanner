import { describe, expect, it } from "vitest";
import { feeDeskLineFromOtcCoin, feeDeskLinesFromOtcRoster } from "./feeDesks.js";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const OTHER = "So11111111111111111111111111111111111111112";

describe("feeDeskLineFromOtcCoin", () => {
  it("names OTC Desks and the reward coin the roster actually gives", () => {
    expect(feeDeskLineFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx" })).toBe(
      "OTC Desks pays holder rewards in NVDAx.",
    );
  });

  it("counts a basket of reward coins when no symbol is named", () => {
    expect(
      feeDeskLineFromOtcCoin({
        mint: MINT,
        rewardBasket: [MINT, OTHER, MINT],
      }),
    ).toBe("OTC Desks pays holder rewards in 2 reward coins.");
  });

  it("names the symbol and the basket together when both are present", () => {
    expect(
      feeDeskLineFromOtcCoin({
        mint: MINT,
        rewardSymbol: "OTC",
        rewardBasket: [MINT, OTHER],
      }),
    ).toBe("OTC Desks pays holder rewards in 2 reward coins (OTC is named).");
  });

  it("says nothing when the roster does not name a reward", () => {
    expect(feeDeskLineFromOtcCoin({ mint: MINT, name: "Paid", rewardCycle: 0 })).toBeNull();
    expect(feeDeskLineFromOtcCoin({ mint: MINT, rewardSymbol: "pending:NVDAx" })).toBeNull();
    expect(feeDeskLineFromOtcCoin({ mint: MINT, rewardBasket: [MINT] })).toBeNull();
    expect(feeDeskLineFromOtcCoin(null)).toBeNull();
  });
});

describe("feeDeskLinesFromOtcRoster", () => {
  it("keeps only coins whose reward routing is actually named", () => {
    const lines = feeDeskLinesFromOtcRoster({
      coins: [
        { mint: MINT, rewardSymbol: "NVDAx" },
        { mint: OTHER, name: "no reward" },
        { mint: "not-a-mint", rewardSymbol: "OTC" },
      ],
    });
    expect([...lines.entries()]).toEqual([[MINT, "OTC Desks pays holder rewards in NVDAx."]]);
  });
});
