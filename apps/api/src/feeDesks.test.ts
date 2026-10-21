import { describe, expect, it } from "vitest";
import { feeDeskFromOtcCoin, feeDeskLineFromOtcCoin, feeDesksFromOtcRoster } from "./feeDesks.js";

const MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const OTHER = "So11111111111111111111111111111111111111112";
const THIRD = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("feeDeskFromOtcCoin", () => {
  it("names one reward coin as that token", () => {
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx" })).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx.",
      rewards: [{ label: "NVDAx", mint: null }],
    });
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx", rewardMint: OTHER })).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx.",
      rewards: [{ label: "NVDAx", mint: OTHER }],
    });
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardMint: OTHER })).toEqual({
      line: "OTC Desks pays holder rewards in So11…1112.",
      rewards: [{ label: "So11…1112", mint: OTHER }],
    });
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx", rewardMint: "pending:NVDAx" })).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx.",
      rewards: [{ label: "NVDAx", mint: null }],
    });
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx", rewardBasket: [OTHER] })).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx.",
      rewards: [{ label: "NVDAx", mint: OTHER }],
    });
    expect(feeDeskLineFromOtcCoin({ mint: MINT, rewardBasket: [{ mint: OTHER, symbol: "TSLAx" }] })).toBe(
      "OTC Desks pays holder rewards in TSLAx.",
    );
  });

  it("names every coin in a two-coin basket instead of counting them", () => {
    expect(
      feeDeskFromOtcCoin({
        mint: MINT,
        rewardBasket: [MINT, OTHER, MINT],
      }),
    ).toEqual({
      line: "OTC Desks pays holder rewards in MukL…pump and So11…1112.",
      rewards: [
        { label: "MukL…pump", mint: MINT },
        { label: "So11…1112", mint: OTHER },
      ],
    });
  });

  it("shortens each mint when a basket-level ticker does not belong to one coin", () => {
    expect(
      feeDeskLineFromOtcCoin({
        mint: MINT,
        rewardSymbol: "OTC",
        rewardBasket: [MINT, OTHER],
      }),
    ).toBe("OTC Desks pays holder rewards in MukL…pump and So11…1112.");
  });

  it("uses each basket entry's ticker or name, and a short mint when an entry has neither", () => {
    expect(
      feeDeskFromOtcCoin({
        mint: MINT,
        rewardSymbol: "OTC",
        rewardBasket: [{ mint: OTHER, symbol: "NVDAx" }, { mint: THIRD, name: "Tesla" }, MINT],
      }),
    ).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx, Tesla, and MukL…pump.",
      rewards: [
        { label: "NVDAx", mint: OTHER },
        { label: "Tesla", mint: THIRD },
        { label: "MukL…pump", mint: MINT },
      ],
    });
  });

  it("shortens a single reward mint that the roster did not name", () => {
    expect(feeDeskLineFromOtcCoin({ mint: MINT, rewardBasket: [OTHER] })).toBe(
      "OTC Desks pays holder rewards in So11…1112.",
    );
  });

  it("says nothing when the roster does not name a reward or the shape changed", () => {
    expect(feeDeskFromOtcCoin({ mint: MINT, name: "Paid", rewardCycle: 0 })).toBeNull();
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "pending:NVDAx" })).toBeNull();
    expect(feeDeskFromOtcCoin({ mint: MINT, rewardBasket: ["not-a-mint"] })).toBeNull();
    expect(
      feeDeskFromOtcCoin({ mint: MINT, rewardSymbol: "NVDAx", rewardBasket: { mint: OTHER } }),
    ).toBeNull();
    expect(feeDeskFromOtcCoin(null)).toBeNull();
  });
});

describe("feeDesksFromOtcRoster", () => {
  it("keeps only coins whose reward routing is actually named", () => {
    const fees = feeDesksFromOtcRoster({
      coins: [
        { mint: MINT, rewardSymbol: "NVDAx" },
        { mint: OTHER, name: "no reward" },
        { mint: "not-a-mint", rewardSymbol: "OTC" },
      ],
    });
    expect([...fees.entries()]).toEqual([
      [MINT, { line: "OTC Desks pays holder rewards in NVDAx.", rewards: [{ label: "NVDAx", mint: null }] }],
    ]);
  });

  it("names every basket coin from the ticker or name already on the roster", () => {
    const fees = feeDesksFromOtcRoster({
      coins: [
        { mint: MINT, rewardBasket: [OTHER, THIRD] },
        { mint: OTHER, symbol: "NVDAx", name: "NVIDIA" },
        { mint: THIRD, name: "Tesla" },
      ],
    });
    expect(fees.get(MINT)).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx and Tesla.",
      rewards: [
        { label: "NVDAx", mint: OTHER },
        { label: "Tesla", mint: THIRD },
      ],
    });
    expect(fees.has(OTHER)).toBe(false);
    expect(fees.has(THIRD)).toBe(false);
  });

  it("prefers a later row that names reward coins over an earlier row that does not", () => {
    const fees = feeDesksFromOtcRoster({
      coins: [
        { mint: MINT, name: "Featured" },
        { mint: MINT, rewardBasket: [OTHER, THIRD] },
        { mint: OTHER, symbol: "NVDAx" },
        { mint: THIRD, symbol: "TSLAx" },
      ],
    });
    expect(fees.get(MINT)).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx and TSLAx.",
      rewards: [
        { label: "NVDAx", mint: OTHER },
        { label: "TSLAx", mint: THIRD },
      ],
    });
  });
});
