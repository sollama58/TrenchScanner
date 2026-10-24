import { describe, expect, it } from "vitest";
import { tradeLinkFromUrl } from "./tradeLink";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

describe("trade links from the extension", () => {
  it("reads a buy in SOL and a sale in percent", () => {
    expect(tradeLinkFromUrl(`?trade=${A}&buy=0.25`, 5)).toEqual({
      mint: A,
      side: "buy",
      amount: 0.25,
      at: 5,
    });
    expect(tradeLinkFromUrl(`?trade=${A}&sell=50`, 5)).toEqual({ mint: A, side: "sell", amount: 50, at: 5 });
  });

  it("fills nothing for a bad mint, amount, or both sides at once", () => {
    expect(tradeLinkFromUrl(`?trade=nope&buy=1`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}&buy=0`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}&buy=1000`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}&sell=150`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}&sell=12.5`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}&buy=1&sell=50`)).toBeNull();
    expect(tradeLinkFromUrl(`?trade=${A}`)).toBeNull();
  });
});
