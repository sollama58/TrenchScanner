import { describe, expect, it } from "vitest";
import { grantCreditsText, pricesChangeText } from "./AdminCredits";

describe("the Burn Credit price confirmation", () => {
  const prices = { tokensPerCredit: 100_000, cost: { token: 1, wallet: 2 } };

  it("shows each setting as old → new", () => {
    const text = pricesChangeText(prices, [10_000, 1, 3]);
    expect(text).toMatch(/per credit: 100,000 → 10,000/);
    expect(text).toMatch(/Token lookup: 1 credits \(unchanged\)/);
    expect(text).toMatch(/Wallet lookup: 2 → 3 credits/);
    expect(text).not.toMatch(/free/);
  });

  it("calls out a lookup made free", () => {
    expect(pricesChangeText(prices, [100_000, 0, 2])).toMatch(/A cost of 0 makes that lookup free/);
  });
});

describe("the Burn Credit grant confirmation", () => {
  const wallet = "AnnounceAdmin1111111111111111111111111111111";

  it("names the whole address", () => {
    expect(grantCreditsText(wallet, 10)).toBe(`Award ${wallet} 10 Burn Credits?`);
    expect(grantCreditsText(wallet, -1)).toBe(`Take 1 credits back from ${wallet}?`);
  });
});
