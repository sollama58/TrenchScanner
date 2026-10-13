import { describe, expect, it } from "vitest";
import {
  bubblesFromUrl,
  bubblesLink,
  buildGraph,
  clusterHalos,
  graphBounds,
  layoutGraph,
  pickReading,
} from "./bubbleMap";

const A = "Aaaa1111111111111111111111111111111111111111";
const B = "Bbbb2222222222222222222222222222222222222222";
const C = "Cccc3333333333333333333333333333333333333333";
const D = "Dddd4444444444444444444444444444444444444444";
const F = "Ffff5555555555555555555555555555555555555555";
const R = "Rrrr6666666666666666666666666666666666666666";

const snapshot = {
  linkedWalletPct: 31,
  top10HolderPct: 48,
  top10WalletsChecked: 10,
  linkedClusters: [
    {
      funder: F,
      wallets: [
        { wallet: A, pct: 12 },
        { wallet: B, pct: 9 },
      ],
      pct: 21,
      creatorLinked: false,
    },
    // C funded D: C is the hub, and a holder.
    {
      funder: C,
      wallets: [
        { wallet: C, pct: 6 },
        { wallet: D, pct: 4 },
      ],
      pct: 10,
      creatorLinked: true,
    },
  ],
};

describe("bubble map graph", () => {
  it("rings holders funded in the same minute and ties each to the first funded", () => {
    const g = buildGraph({
      ...snapshot,
      sameTimeFundedPct: 18,
      sameTimeClusters: [
        {
          atMs: 1_000,
          spanMs: 40_000,
          pct: 18,
          wallets: [
            { wallet: A, pct: 12, fundedAtMs: 41_000, funder: F },
            { wallet: R, pct: 6, fundedAtMs: 1_000, funder: null },
          ],
        },
      ],
    });
    // R is in no shared-funder cluster: it gets a bubble of its own.
    expect(g.nodes.find((n) => n.wallet === R)).toMatchObject({ kind: "holder", cluster: null, sameTime: 0 });
    expect(g.nodes.find((n) => n.wallet === A)?.sameTime).toBe(0);
    expect(g.sameTimeLinks).toEqual([{ from: `h:${A}`, to: `h:${R}`, group: 0 }]);
    expect(g.sameTimePct).toBe(18);
    expect(layoutGraph(g).nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("links each holder to its funder, with a funder node only when the funder holds none", () => {
    const g = buildGraph(snapshot);
    expect(g.nodes.filter((n) => n.kind === "funder").map((n) => n.wallet)).toEqual([F]);
    expect(g.links).toEqual([
      { from: `h:${A}`, to: `f:${F}`, cluster: 0 },
      { from: `h:${B}`, to: `f:${F}`, cluster: 0 },
      { from: `h:${D}`, to: `h:${C}`, cluster: 1 },
    ]);
    expect(g.nodes.find((n) => n.wallet === C)?.hub).toBe(true);
  });

  it("draws the rest of the top 10 as one bubble", () => {
    const rest = buildGraph(snapshot).nodes.find((n) => n.kind === "rest");
    expect(rest).toMatchObject({ count: 6, pct: 17 });
  });

  it("rings flagged holders, and adds a flagged top holder outside every cluster", () => {
    const g = buildGraph(snapshot, [
      { wallet: A, tags: ["risky", "linked"], score: 88, dumps: 1, heldPct: 12 },
      { wallet: R, tags: ["dumper"], score: 40, dumps: 4, heldPct: 3 },
      { wallet: "tiny", tags: ["risky"], score: 90, dumps: 0, heldPct: 0.1 },
      { wallet: "plain", tags: ["linked"], score: null, dumps: null, heldPct: 5 },
    ]);
    expect(g.nodes.find((n) => n.wallet === A)).toMatchObject({ flags: ["risky"], score: 88 });
    expect(g.nodes.find((n) => n.wallet === R)).toMatchObject({ cluster: null, pct: 3, flags: ["dumper"] });
    expect(g.nodes.some((n) => n.wallet === "tiny" || n.wallet === "plain")).toBe(false);
    expect(g.nodes.find((n) => n.kind === "rest")).toMatchObject({ count: 5, pct: 14 });
  });

  it("names a KOL holder without ringing it as risky", () => {
    const g = buildGraph(snapshot, [
      { wallet: A, tags: ["kol", "linked"], score: null, dumps: null, heldPct: 12, kol: "Cupsey" },
      { wallet: R, tags: ["kol"], score: null, dumps: null, heldPct: 3, kol: "" },
    ]);
    expect(g.nodes.find((n) => n.wallet === A)).toMatchObject({ flags: [], kol: "Cupsey" });
    expect(g.nodes.find((n) => n.wallet === R)).toMatchObject({ cluster: null, flags: [], kol: "" });
    expect(g.nodes.find((n) => n.wallet === B)?.kol).toBeNull();
  });

  it("lays out without overlaps, the same way every time", () => {
    const one = layoutGraph(buildGraph(snapshot));
    const two = layoutGraph(buildGraph(snapshot));
    expect(one.nodes.map((n) => [n.x, n.y])).toEqual(two.nodes.map((n) => [n.x, n.y]));
    for (let i = 0; i < one.nodes.length; i += 1) {
      for (let j = i + 1; j < one.nodes.length; j += 1) {
        const a = one.nodes[i]!;
        const b = one.nodes[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    }
    const box = graphBounds(one);
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
  });

  it("picks the newest reading with clusters", () => {
    const rows = [
      { linkedWalletPct: null, linkedClusters: null, id: 1 },
      { linkedWalletPct: 0, linkedClusters: null, id: 2 },
      { linkedWalletPct: 20, linkedClusters: snapshot.linkedClusters, id: 3 },
    ];
    expect(pickReading(rows)?.id).toBe(3);
    expect(pickReading(rows.slice(0, 2))?.id).toBe(2);
    expect(pickReading([])).toBeNull();
  });
});

describe("bubble map link", () => {
  it("reads a mint from the address bar and builds a clean link", () => {
    expect(bubblesFromUrl(`?bubbles=${A}`)).toBe(A);
    expect(bubblesFromUrl("?bubbles=nope")).toBeNull();
    expect(bubblesLink(A, "https://trenchscanner.app/?sage=x#lighthouse")).toBe(
      `https://trenchscanner.app/?bubbles=${A}`,
    );
  });
});

describe("bubble map holders", () => {
  it("gives every unlinked holder its own bubble when the scan kept the list", () => {
    const g = buildGraph({
      ...snapshot,
      top10WalletsChecked: 7,
      linkedHolders: [
        { wallet: A, pct: 12 },
        { wallet: B, pct: 9 },
        { wallet: C, pct: 6 },
        { wallet: D, pct: 4 },
        { wallet: R, pct: 8 },
        { wallet: "Lone2", pct: 5 },
        { wallet: "Lone3", pct: 4 },
      ],
    });
    const lone = g.nodes.filter((n) => n.kind === "holder" && n.cluster === null).map((n) => n.wallet);
    expect(lone).toEqual([R, "Lone2", "Lone3"]);
    expect(g.nodes.some((n) => n.kind === "rest")).toBe(false);
  });
});

describe("bubble map halos", () => {
  it("hugs each cluster's own bubbles and links, and the bounds hold every halo", () => {
    const g = layoutGraph(buildGraph(snapshot));
    const halos = clusterHalos(g);
    expect(halos.map((h) => [h.cluster, h.circles.length, h.bands.length])).toEqual([
      [0, 3, 2],
      [1, 2, 1],
    ]);
    const box = graphBounds(g, 0);
    for (const c of halos.flatMap((h) => h.circles)) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(c.y + c.r).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
  });
});
