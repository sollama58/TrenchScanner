import { describe, expect, it } from "vitest";
import { bundledSupply, kolBundledPct } from "./kolBundled.js";

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

describe("bundledSupply", () => {
  it("takes in the linked holders and every KOL bundle, each once", () => {
    const ties = [{ wallet: "fund", kolWallet: "kol" }];
    // Linked: side, mate, far (clusters) and fund, min (minute) = 4. KOL bundle adds kol 2.
    expect(bundledSupply({ holders, clusters, sameTimeClusters, isKol, ties })).toEqual({ pct: 6, count: 6 });
  });
  it("is the linked holders alone with no KOL bundle", () => {
    expect(bundledSupply({ holders, clusters, sameTimeClusters, isKol: () => false, ties: [] })).toEqual({
      pct: 4,
      count: 5,
    });
  });
  it("counts a KOL bundle with no linked holders", () => {
    expect(
      bundledSupply({
        holders,
        clusters: [],
        sameTimeClusters: [],
        isKol,
        ties: [{ wallet: "x", kolWallet: "kol" }],
      }),
    ).toEqual({ pct: 6, count: 2 });
  });
});

describe("transfers out of a KOL's bundle", () => {
  const ties = [{ wallet: "side", kolWallet: "kol" }];
  it("takes in every holder the KOL or its bundle sent the coin to, and on from there", () => {
    // kol 2 + side 1.5 + mate 0.5; mate sent to far (two steps out by funding), far on to x.
    const transfers = [
      { from: "mate", to: "far", pct: 0.7 },
      { from: "far", to: "x", pct: 0.4 },
    ];
    expect(kolBundledPct({ holders, clusters, sameTimeClusters, isKol, ties, transfers })).toBe(8.7);
    expect(kolBundledPct({ holders, clusters, sameTimeClusters, isKol, ties })).toBe(4);
  });
  it("leaves out dust and sends into the bundle", () => {
    const transfers = [
      { from: "side", to: "x", pct: 0.01 },
      { from: "min", to: "kol", pct: 0.5 },
    ];
    expect(kolBundledPct({ holders, clusters, sameTimeClusters, isKol, ties, transfers })).toBe(4);
  });
  it("makes a lone KOL that sent supply out a bundle", () => {
    const transfers = [{ from: "kol", to: "min", pct: 0.3 }];
    expect(kolBundledPct({ holders, clusters, sameTimeClusters, isKol, ties: [], transfers })).toBe(2.3);
  });
});
