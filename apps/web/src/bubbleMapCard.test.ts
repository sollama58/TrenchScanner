import { describe, expect, it } from "vitest";
import { shareableSides } from "./bubbleMapCard";

describe("shareableSides", () => {
  it("keeps only the on-chain or known ties a share image may name (audit 10-27 SW-9)", () => {
    const sides = shareableSides([
      {
        kolWallet: "kol1",
        kolName: "A KOL",
        wallets: [
          { wallet: "w1", pct: 2 },
          { wallet: "w2", pct: 1, funded: true },
          { wallet: "w3", pct: 1, known: true },
        ],
      },
      { kolWallet: "kol2", kolName: "Timing only", wallets: [{ wallet: "w4", pct: 3 }] },
    ]);
    expect(sides).toHaveLength(1);
    expect(sides[0]!.wallets.map((w) => w.wallet)).toEqual(["w2", "w3"]);
  });
});
