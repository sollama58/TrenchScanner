import { describe, expect, it } from "vitest";
import { DEFAULT_QUICK_BUY, DEFAULT_TRADE_SETTINGS, parseTradeSettings } from "./proTrade";
import { presetCols } from "./components/TradePanel";
import { parseAmounts } from "./decimal";
import { nextBuy, nextSell } from "./components/TradingSettingsPanel";

const parse = (v: object) => parseTradeSettings(JSON.stringify(v));

describe("trade settings", () => {
  it("defaults to one row of buy buttons and quick buy off", () => {
    expect(parseTradeSettings(null)).toEqual(DEFAULT_TRADE_SETTINGS);
    expect(parseTradeSettings("not json")).toEqual(DEFAULT_TRADE_SETTINGS);
    expect(DEFAULT_TRADE_SETTINGS.buyRows).toBe(1);
    expect(DEFAULT_TRADE_SETTINGS.quickBuy).toEqual(DEFAULT_QUICK_BUY);
    expect(DEFAULT_QUICK_BUY.enabled).toBe(false);
    // Settings saved before these fields existed still load.
    expect(parse({ buyPresets: [1, 2] })).toMatchObject({
      buyPresets: [1, 2],
      buyRows: 1,
      quickBuy: DEFAULT_QUICK_BUY,
    });
  });

  it("allows five buy buttons a row", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(parse({ buyRows: 2, buyPresets: ten }).buyPresets).toEqual(ten);
    expect(parse({ buyRows: 1, buyPresets: ten }).buyPresets).toEqual(DEFAULT_TRADE_SETTINGS.buyPresets);
    expect(parse({ buyRows: 1, buyPresets: [1, 2, 3, 4, 5] }).buyPresets).toHaveLength(5);
    expect(parse({ buyRows: 3 }).buyRows).toBe(1);
  });

  it("keeps a valid quick buy and drops a bad one", () => {
    const good = { enabled: true, amountSol: 0.5, position: "bottom-left", size: "l", color: "purple" };
    expect(parse({ quickBuy: good }).quickBuy).toEqual(good);
    expect(
      parse({ quickBuy: { enabled: "yes", amountSol: -1, position: "middle", size: "xl", color: "#f00" } })
        .quickBuy,
    ).toEqual(DEFAULT_QUICK_BUY);
    expect(parse({ quickBuy: { amountSol: 500 } }).quickBuy.amountSol).toBe(DEFAULT_QUICK_BUY.amountSol);
    // Below the API's 0.01 SOL minimum.
    expect(parse({ quickBuy: { amountSol: 0.005 } }).quickBuy.amountSol).toBe(DEFAULT_QUICK_BUY.amountSol);
    expect(parse({ buyPresets: [0.005, 1] }).buyPresets).toEqual(DEFAULT_TRADE_SETTINGS.buyPresets);
  });

  it("splits buy buttons over one or two rows", () => {
    expect(presetCols(4)).toEqual({ "--cols": 4 });
    expect(presetCols(10, 2)).toEqual({ "--cols": 5 });
    expect(presetCols(7, 2)).toEqual({ "--cols": 4 });
    expect(presetCols(0)).toEqual({ "--cols": 1 });
  });

  it("reads typed amount lists", () => {
    expect(parseAmounts("0.1, 0.25 0.5,,1", 100, 5)).toEqual([0.1, 0.25, 0.5, 1]);
    expect(parseAmounts("1 2 3 4 5 6", 100, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(parseAmounts("-1 abc 0 150 50", 100, 5)).toEqual([50]);
    expect(parseAmounts("", 100, 5)).toEqual([]);
    expect(parseAmounts("0.005 0.01 0.5", 100, 5, 0.01)).toEqual([0.01, 0.5]);
  });
});

describe("new preset buttons", () => {
  it("starts a buy at double the biggest, within 100 SOL", () => {
    expect(nextBuy([0.1, 0.25, 0.5, 1])).toBe(2);
    expect(nextBuy([80])).toBe(100);
    expect(nextBuy([])).toBe(0.1);
  });
  it("starts a sale at the first common share not there yet", () => {
    expect(nextSell([25, 50, 100])).toBe(75);
    expect(nextSell([100])).toBe(50);
  });
});
