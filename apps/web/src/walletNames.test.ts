import { describe, expect, it } from "vitest";
import { visibleNames, walletText, type WalletNames } from "./walletNames";

const W = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

describe("walletText", () => {
  it("shows a named wallet by its name, and any other by its short address", () => {
    expect(walletText(W, { [W]: { name: "Cupsey", source: "kol" } })).toBe("Cupsey");
    expect(walletText(W, {})).toBe("5tzF…uAi9");
    expect(walletText(W)).toBe("5tzF…uAi9");
    expect(walletText(null)).toBe("");
    expect(walletText(W, { [W]: { name: "degen", source: "pumpfun" } })).toBe('"degen"');
  });
});

describe("visibleNames", () => {
  const names: WalletNames = {
    kol: { name: "Cupsey", source: "kol" },
    cex: { name: "Binance", source: "exchange" },
    pump: { name: "degen", source: "pumpfun" },
    fomo: { name: "fren", source: "fomo" },
    helius: { name: "Some Wallet", source: "identity" },
  };
  const off = {
    bubbleNameLabels: false,
    bubbleNamesPumpfun: null,
    bubbleNamesFomo: null,
    bubbleNamesHelius: null,
  };

  it("hides Pump.fun, FOMO and Helius names by default, keeping KOLs and exchanges", () => {
    expect(Object.keys(visibleNames(names, off))).toEqual(["kol", "cex"]);
  });

  it("shows them all when switched on, returning the same names", () => {
    expect(visibleNames(names, { ...off, bubbleNameLabels: true })).toBe(names);
  });

  it("follows a kind set on its own, and keeps the wallets asked to keep", () => {
    expect(Object.keys(visibleNames(names, { ...off, bubbleNamesFomo: true }))).toEqual([
      "kol",
      "cex",
      "fomo",
    ]);
    expect(Object.keys(visibleNames(names, off, false, new Set(["helius"])))).toEqual([
      "kol",
      "cex",
      "helius",
    ]);
  });
});
