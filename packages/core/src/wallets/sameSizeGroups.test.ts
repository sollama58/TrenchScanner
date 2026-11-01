import { describe, expect, it } from "vitest";
import { launchSameSizeWallets, sameSizeGroupReading } from "./sameSizeGroups.js";
import type { TapeTrade } from "./tradeTape.js";

function buy(wallet: string, sol: number, atMs: number, side: TapeTrade["side"] = "buy"): TapeTrade {
  return { wallet, side, sol, tokens: 1000, atMs, tx: `${wallet}-${atMs}-${side}` };
}

describe("sameSizeGroupReading", () => {
  it("finds three single-buy wallets buying the same SOL in the same second, and their share", () => {
    const trades = [
      buy("a", 0.5, 10_000),
      buy("b", 0.5, 10_400),
      buy("c", 0.5, 10_900),
      buy("d", 0.5, 11_000), // the next second: not in the group
      buy("e", 1.5, 10_500), // another size
    ];
    expect(sameSizeGroupReading(trades)).toEqual({ sameSizeGroupWallets: 3, sameSizeGroupSolShare: 0.429 });
  });

  it("reads 0 under three wallets, for wallets that bought twice, and for sells", () => {
    expect(sameSizeGroupReading([buy("a", 0.5, 10_000), buy("b", 0.5, 10_100)])).toEqual({
      sameSizeGroupWallets: 0,
      sameSizeGroupSolShare: 0,
    });
    // `a` bought twice on the page: a trader topping up, not a row of wallets.
    expect(
      sameSizeGroupReading([
        buy("a", 0.5, 10_000),
        buy("a", 0.5, 12_000),
        buy("b", 0.5, 10_100),
        buy("c", 0.5, 10_200),
      ]).sameSizeGroupWallets,
    ).toBe(0);
    expect(
      sameSizeGroupReading([
        buy("a", 0.5, 10_000, "sell"),
        buy("b", 0.5, 10_100, "sell"),
        buy("c", 0.5, 10_200, "sell"),
      ]),
    ).toEqual({ sameSizeGroupWallets: 0, sameSizeGroupSolShare: null });
  });

  it("tells sizes apart at six decimals and leaves the launch second out of a complete page", () => {
    const trades = [buy("a", 0.1234564, 10_000), buy("b", 0.1234561, 10_000), buy("c", 0.123456, 10_000)];
    expect(sameSizeGroupReading(trades).sameSizeGroupWallets).toBe(3);
    expect(sameSizeGroupReading([...trades, buy("d", 0.12346, 10_000)]).sameSizeGroupWallets).toBe(3);
    // The page starts at the launch: its first second is block zero, read elsewhere.
    expect(sameSizeGroupReading(trades, true).sameSizeGroupWallets).toBe(0);
    expect(sameSizeGroupReading([buy("dev", 2, 9_000), ...trades], true).sameSizeGroupWallets).toBe(3);
  });
});

describe("launchSameSizeWallets", () => {
  const b = (wallet: string, bought: number, slot: number | null) => ({ wallet, bought, slot });
  it("counts first buyers with the same tokens in the same slot past the create slot", () => {
    const buyers = [b("z", 500, 100), b("a", 300, 101), b("b", 300, 101), b("c", 300, 101), b("d", 300, 102)];
    expect(launchSameSizeWallets(buyers, 100)).toBe(3);
    // Block zero's matching buys are the launch bundle's, counted by BLOCK_ZERO_FEATURES.
    expect(launchSameSizeWallets([b("a", 300, 100), b("b", 300, 100), b("c", 300, 100)], 100)).toBe(0);
    expect(launchSameSizeWallets([b("a", 300, 101), b("b", 300, 101)], 100)).toBe(0);
  });
  it("is unknown without slots or buyers", () => {
    expect(launchSameSizeWallets([b("a", 300, null), b("b", 300, null)], null)).toBeNull();
    expect(launchSameSizeWallets([], null)).toBeNull();
  });
});
