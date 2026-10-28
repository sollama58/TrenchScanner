import { describe, expect, it } from "vitest";
import { tokenFromWorkerMessage, tokenLinkFromUrl, tokenLinkPath, tradeLinkFromUrl } from "./tradeLink";

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

describe("tokenLinkFromUrl", () => {
  it("reads a mint, and nothing else", () => {
    expect(tokenLinkFromUrl(`?token=${A}`)).toBe(A);
    expect(tokenLinkFromUrl(`?token=nope`)).toBeNull();
    expect(tokenLinkFromUrl(`?sage=${A}`)).toBeNull();
  });
});

describe("notification clicks", () => {
  it("reads the service worker's open-token message and nothing else", () => {
    expect(tokenFromWorkerMessage({ type: "ts-open-token", mint: A })).toBe(A);
    expect(tokenFromWorkerMessage({ type: "ts-open-token", mint: "not a mint" })).toBeNull();
    expect(tokenFromWorkerMessage({ type: "other", mint: A })).toBeNull();
    expect(tokenFromWorkerMessage("ts-open-token")).toBeNull();
    expect(tokenFromWorkerMessage(null)).toBeNull();
  });

  it("links a notification to the coin's ?token= view", () => {
    expect(tokenLinkFromUrl(tokenLinkPath(A).slice(1))).toBe(A);
  });
});
