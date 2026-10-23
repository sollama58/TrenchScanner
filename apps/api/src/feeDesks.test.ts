import { describe, expect, it } from "vitest";
import {
  creatorFeeWalletAddresses,
  feeDeskFromOtcCoin,
  feeDeskLineFromOtcCoin,
  feeDesksFromOtcRoster,
  OTC_DESKS_FEE_WALLET,
  paysOtcDesks,
  resolveOtcDeskFee,
} from "./feeDesks.js";

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

  it("reads a renamed basket and address fields, and a case-different reward mint", () => {
    const flipped = `${OTHER[0]!.toLowerCase()}${OTHER.slice(1)}`;
    expect(
      feeDeskFromOtcCoin({
        mint: MINT,
        rewardBasket: [
          { address: OTHER, ticker: "NVDAx" },
          { address: THIRD, ticker: "TSLAx" },
        ],
      }),
    ).toEqual({
      line: "OTC Desks pays holder rewards in NVDAx and TSLAx.",
      rewards: [
        { label: "NVDAx", mint: OTHER },
        { label: "TSLAx", mint: THIRD },
      ],
    });
    const fees = feeDesksFromOtcRoster({
      data: {
        coins: [
          { mint: MINT, rewards: [flipped, THIRD] },
          { mint: OTHER, symbol: "NVDAx" },
          { mint: THIRD, symbol: "TSLAx" },
        ],
      },
    });
    expect(fees.get(MINT)?.line).toBe("OTC Desks pays holder rewards in NVDAx and TSLAx.");
  });

  it("matches a creator-fee wallet listed once on the desk coin, and not a shared wallet", () => {
    const wallet = "4NVt2u8V7YwQj3k6mP8sR2tU5vW7xY9zA1bC3dE5fG7";
    const shared = "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD";
    const otherCoin = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    const fees = feeDesksFromOtcRoster({
      coins: [
        { mint: MINT, wallet, rewardBasket: [OTHER, THIRD] },
        { mint: otherCoin, wallet: shared, rewardSymbol: "NVDAx" },
        { mint: THIRD, symbol: "TSLAx", wallet: shared, rewardSymbol: "TSLAx" },
        { mint: OTHER, symbol: "NVDAx" },
      ],
    });
    expect(fees.get(wallet)?.line).toBe("OTC Desks pays holder rewards in NVDAx and TSLAx.");
    expect(fees.has(shared)).toBe(false);
    expect(resolveOtcDeskFee(otherCoin, [wallet], fees)?.line).toBe(
      "OTC Desks pays holder rewards in NVDAx.",
    );
    expect(
      creatorFeeWalletAddresses(
        {
          admin: wallet,
          recipients: [
            { address: MINT, kind: "creator", is_creator: true },
            { address: wallet, kind: "wallet" },
          ],
        },
        wallet,
      ),
    ).toEqual([wallet]);
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

describe("paysOtcDesks (user report 2026-10-23)", () => {
  it("knows OTC Desks' own fee wallet", () => {
    expect(paysOtcDesks([OTC_DESKS_FEE_WALLET])).toBe(true);
    expect(paysOtcDesks(["8PQxd6VmfGPMyg8WPnfkT9jUTmtE7UsnDmvBKXeAVP9z"])).toBe(false);
    expect(paysOtcDesks(null)).toBe(false);
  });
});
