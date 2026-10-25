import { describe, expect, it } from "vitest";
import { coinPriceText, heldCoins } from "./QuickTradeDrawer";
import type { TradeCoin } from "./TradesDrawer";

describe("coinPriceText", () => {
  it("keeps four significant figures, counting long runs of zeros in a subscript", () => {
    expect(coinPriceText(0.000004321)).toBe("$0.0₅4321");
    expect(coinPriceText(0.00000000012345)).toBe("$0.0₉1235");
    expect(coinPriceText(0.0001843)).toBe("$0.0001843");
    expect(coinPriceText(0.05)).toBe("$0.05");
    expect(coinPriceText(0.5)).toBe("$0.5");
  });
  it("rounds up across a power of ten without an extra zero", () => {
    expect(coinPriceText(0.099999)).toBe("$0.1");
    expect(coinPriceText(0.0000099999)).toBe("$0.0₄1");
    expect(coinPriceText(0.99999)).toBe("$1.000");
  });
  it("shows dollars and above plainly, and a dash for nothing", () => {
    expect(coinPriceText(1.2345)).toBe("$1.234");
    expect(coinPriceText(152.3)).toBe("$152.30");
    expect(coinPriceText(64123.4)).toBe("$64,123");
    expect(coinPriceText(null)).toBe("–");
    expect(coinPriceText(0)).toBe("–");
    expect(coinPriceText(Number.NaN)).toBe("–");
  });
});

describe("heldCoins", () => {
  const coin = (mint: string, lastTradeAt: string, patch: Partial<TradeCoin> = {}) =>
    ({ mint, lastTradeAt, closed: false, mismatch: false, chainHeld: 1, ...patch }) as TradeCoin;
  it("lists what is still held, newest trade first", () => {
    const list = heldCoins([
      coin("a", "2026-10-25T10:00:00Z"),
      coin("b", "2026-10-25T12:00:00Z"),
      coin("sold", "2026-10-25T13:00:00Z", { closed: true }),
      coin("gone", "2026-10-25T14:00:00Z", { mismatch: true, chainHeld: 0 }),
      coin("odd", "2026-10-25T11:00:00Z", { mismatch: true, chainHeld: 5 }),
    ]);
    expect(list.map((c) => c.mint)).toEqual(["b", "odd", "a"]);
  });
});
