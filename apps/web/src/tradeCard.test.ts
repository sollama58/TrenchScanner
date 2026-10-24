import { describe, expect, it } from "vitest";
import { tradeCardNote, updatedText, type TradeCoin } from "./components/TradesDrawer";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const coin = (over: Partial<TradeCoin>): TradeCoin => ({
  mint: "M",
  symbol: "M",
  name: null,
  imageUrl: null,
  entryAt: "2026-10-24T11:00:00Z",
  lastTradeAt: "2026-10-24T11:00:00Z",
  buys: 1,
  sells: 0,
  spentSol: 1,
  gotSol: 0,
  held: 100,
  closed: false,
  entryMcapUsd: 10_000,
  pnlSol: 0.2,
  pnlPct: 20,
  calledBefore: null,
  card: null,
  scan: "scanned",
  priceAt: new Date(NOW - 5_000).toISOString(),
  priceSource: "curve",
  chainHeld: 100,
  mismatch: false,
  ...over,
});

describe("tradeCardNote", () => {
  it("says nothing for a coin priced live just now, or one sold out", () => {
    expect(tradeCardNote(coin({}), NOW)).toBeNull();
    expect(tradeCardNote(coin({ priceSource: "market" }), NOW)).toBeNull();
    expect(tradeCardNote(coin({ closed: true, priceSource: null, priceAt: null }), NOW)).toBeNull();
  });

  it("names an old or stored price with its time", () => {
    expect(tradeCardNote(coin({ priceAt: new Date(NOW - 5 * 60_000).toISOString() }), NOW)).toBe(
      "Price as of 5m ago",
    );
    expect(
      tradeCardNote(coin({ priceSource: "stored", priceAt: new Date(NOW - 20_000).toISOString() }), NOW),
    ).toBe("Price as of just now");
    expect(tradeCardNote(coin({ priceSource: "stored", priceAt: null }), NOW)).toBe("Price time unknown");
  });

  it("says why a coin whose trades don't match the wallet has no PnL", () => {
    expect(tradeCardNote(coin({ mismatch: true, chainHeld: 0, pnlSol: null }), NOW)).toBe(
      "Your wallet no longer holds it, and the sale couldn't be read",
    );
    expect(tradeCardNote(coin({ mismatch: true, chainHeld: 40, pnlSol: null }), NOW)).toBe(
      "Your wallet's balance doesn't match the trades read",
    );
  });

  it("stays quiet for an older API without the fields", () => {
    expect(tradeCardNote(coin({ priceSource: undefined, priceAt: undefined }), NOW)).toBeNull();
  });
});

describe("updatedText", () => {
  it("says when the answer was worked out, and when a refresh failed", () => {
    expect(updatedText(new Date(NOW - 10_000).toISOString(), false, NOW)).toBe("Updated just now");
    expect(updatedText(new Date(NOW - 3 * 60_000).toISOString(), true, NOW)).toBe(
      "Couldn't refresh · as of 3m ago",
    );
    expect(updatedText(undefined, false, NOW)).toBeNull();
  });
});
