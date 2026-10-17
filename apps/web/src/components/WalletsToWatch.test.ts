import { describe, expect, it } from "vitest";
import { MIN_CLOSED, MIN_GRADED, sortWallets, type WalletScorecard } from "./WalletsToWatch";

const card = (wallet: string, over: Partial<WalletScorecard> = {}): WalletScorecard => ({
  wallet,
  name: null,
  twitter: null,
  sides: 0,
  coins: 10,
  coinTiers: { graded: 10, won2x: 2, won4x: 0, won10x: 0, tenXGraded: 10 },
  closed: 5,
  returnPct: 0,
  closedSolIn: 5,
  closedSolOut: 5,
  medianReturnPct: 0,
  inProfit: 2,
  own2x: 0,
  own4x: 0,
  own10x: 0,
  solIn: 10,
  solOut: 10,
  early: 0,
  snipes: 0,
  fastExits: 0,
  medianHoldMinutes: null,
  best: null,
  ...over,
});

describe("sortWallets", () => {
  it("ranks by 2x rate, with thin wallets after the rest whatever their rate", () => {
    const lucky = card("lucky", {
      coins: 3,
      coinTiers: { graded: MIN_GRADED - 1, won2x: 3, won4x: 0, won10x: 0, tenXGraded: 4 },
    });
    const good = card("good", { coinTiers: { graded: 10, won2x: 4, won4x: 1, won10x: 0, tenXGraded: 10 } });
    const plain = card("plain");
    expect(sortWallets([lucky, plain, good], "rate2x").map((w) => w.wallet)).toEqual([
      "good",
      "plain",
      "lucky",
    ]);
  });

  it("needs enough closed trades to rank by return, and ranks net SOL for everyone", () => {
    const few = card("few", { closed: MIN_CLOSED - 1, returnPct: 900, solOut: 50 });
    const up = card("up", { returnPct: 40, solOut: 12 });
    const down = card("down", { returnPct: -20, solOut: 4 });
    expect(sortWallets([few, down, up], "return").map((w) => w.wallet)).toEqual(["up", "down", "few"]);
    expect(sortWallets([down, up, few], "net").map((w) => w.wallet)).toEqual(["few", "up", "down"]);
  });
});
