import { describe, expect, it } from "vitest";
import { kolBundledPct } from "./kolBundled.js";

const holders = [
  { wallet: "kol", pct: 2 },
  { wallet: "side", pct: 1.5 },
  { wallet: "mate", pct: 0.5 },
  { wallet: "min", pct: 0.3 },
  { wallet: "fund", pct: 1 },
  { wallet: "far", pct: 0.7 },
  { wallet: "x", pct: 4 },
];
const clusters = [
  { wallets: [{ wallet: "side" }, { wallet: "mate" }] },
  { wallets: [{ wallet: "mate" }, { wallet: "far" }] },
];
const sameTimeClusters = [{ wallets: [{ wallet: "fund" }, { wallet: "min" }] }];
const isKol = (w: string) => w === "kol" || w === "solo";

describe("kolBundledPct", () => {
  it("sums the KOL, its side and funded wallets and holders one step from them, each once", () => {
    const ties = [
      { wallet: "side", kolWallet: "kol" },
      { wallet: "fund", kolWallet: "kol" },
    ];
    // kol 2 + side 1.5 + fund 1 + mate 0.5 (side's cluster) + min 0.3 (fund's minute); "far" is two steps out.
    expect(kolBundledPct({ holders, clusters, sameTimeClusters, isKol, ties })).toBe(5.3);
  });
  it("counts side wallets of a KOL that doesn't hold", () => {
    expect(
      kolBundledPct({
        holders,
        clusters: [],
        sameTimeClusters: [],
        isKol,
        ties: [{ wallet: "x", kolWallet: "elsewhere" }],
      }),
    ).toBe(4);
  });
  it("leaves out a KOL holding alone", () => {
    expect(kolBundledPct({ holders, clusters: [], sameTimeClusters: [], isKol, ties: [] })).toBe(0);
  });
  it("takes in a KOL's own cluster with no side wallets", () => {
    const c = [{ wallets: [{ wallet: "kol" }, { wallet: "x" }] }];
    expect(kolBundledPct({ holders, clusters: c, sameTimeClusters: [], isKol, ties: [] })).toBe(6);
  });
});
