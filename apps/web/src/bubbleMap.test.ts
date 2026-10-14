import { describe, expect, it } from "vitest";
import {
  bubbleNameLines,
  NAME_MAX_W,
  placeLabels,
  exchangeName,
  centreOf,
  type MapNode,
  cexGroupsOf,
  cexLayout,
  cexLinksOf,
  MAP_COLOURS,
  nodeSlot,
  sameTimeSlot,
  bubblesFromUrl,
  bubblesLink,
  buildGraph,
  linkedCount,
  linkedCountText,
  sameTimeCount,
  clusterHalos,
  graphBounds,
  hasHolderList,
  holderFreshness,
  layoutGraph,
  pickReading,
  withWideMap,
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

  it("falls back to a reading that only kept the holder list", () => {
    const holders = [{ wallet: A, pct: 12 }];
    const rows = [
      { linkedWalletPct: null, linkedClusters: null, linkedHolders: null, id: 1 },
      { linkedWalletPct: null, linkedClusters: null, linkedHolders: holders, id: 2 },
      { linkedWalletPct: 0, linkedClusters: null, linkedHolders: null, id: 3 },
    ];
    expect(pickReading(rows)?.id).toBe(2);
    expect(hasHolderList(rows[1]!)).toBe(true);
    expect(hasHolderList(rows[0]!)).toBe(false);
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

describe("bubble map top 100", () => {
  const wide = {
    readAt: "2026-10-14T02:00:00Z",
    holdersRead: 100,
    knownExtra: 1,
    holders: [
      { wallet: A, pct: 12 },
      { wallet: B, pct: 9 },
      { wallet: R, pct: 0.4, rank: 57 },
    ],
    clusters: [
      {
        funder: F,
        wallets: [
          { wallet: A, pct: 12 },
          { wallet: B, pct: 9 },
          { wallet: R, pct: 0.4 },
        ],
        pct: 21.4,
        creatorLinked: false,
      },
    ],
    sameTimeClusters: [],
  };

  it("draws an alerted coin's known top-100 wallets in their clusters, with their rank, counts unchanged", () => {
    const g = buildGraph({ ...snapshot, linkedWalletCount: 4, linkedWalletsChecked: 25 } as never);
    const w = buildGraph(withWideMap({ ...snapshot, linkedWalletCount: 4, linkedWalletsChecked: 25 }, wide));
    const r = w.nodes.find((n) => n.wallet === R)!;
    expect(r).toMatchObject({ kind: "holder", cluster: 0, rank: 57 });
    expect(w.links).toContainEqual({ from: `h:${R}`, to: `f:${F}`, cluster: 0 });
    expect(w.nodes.find((n) => n.wallet === A)!.rank).toBeUndefined();
    expect(w.linkedCount).toEqual(g.linkedCount);
    expect(w.linkedPct).toBe(31);
  });

  it("leaves the snapshot as it is without a wider map", () => {
    const s = { ...snapshot, linkedHolders: [{ wallet: A, pct: 12 }] };
    expect(withWideMap(s, null)).toBe(s);
    expect(withWideMap(s, { ...wide, holders: [] })).toBe(s);
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

describe("linkedCount", () => {
  it("reads the stored count, and counts the clusters' wallets on older scans", () => {
    expect(linkedCount({ linkedWalletPct: 12, linkedWalletCount: 4, linkedWalletsChecked: 20 })).toEqual({
      linked: 4,
      of: 20,
    });
    const older = {
      linkedWalletPct: 12,
      linkedClusters: [
        {
          funder: "F",
          wallets: [
            { wallet: "a", pct: 5 },
            { wallet: "b", pct: 4 },
          ],
          pct: 9,
          creatorLinked: false,
        },
        { funder: "G", wallets: [{ wallet: "c", pct: 3 }], pct: 3, creatorLinked: false },
      ],
      linkedHolders: Array.from({ length: 18 }, (_, i) => ({ wallet: `w${i}`, pct: 1 })),
    };
    expect(linkedCount(older)).toEqual({ linked: 3, of: 18 });
    expect(linkedCountText(linkedCount(older))).toBe("3/18");
    expect(linkedCount({ linkedWalletPct: null })).toBeNull();
  });
});

describe("sameTimeCount", () => {
  it("reads the stored count, and counts the groups' wallets on older scans", () => {
    expect(
      sameTimeCount({
        sameTimeFundedPct: 9,
        sameTimeFundedCount: 3,
        linkedWalletPct: 0,
        linkedWalletsChecked: 20,
      }),
    ).toEqual({ linked: 3, of: 20 });
    const g = (w: string) => ({ wallet: w, pct: 1, fundedAtMs: 0, funder: null });
    expect(
      sameTimeCount({
        sameTimeFundedPct: 4,
        sameTimeClusters: [{ atMs: 0, spanMs: 10_000, wallets: [g("a"), g("b")], pct: 2 }],
      }),
    ).toEqual({ linked: 2, of: 20 });
    expect(sameTimeCount({ sameTimeFundedPct: null })).toBeNull();
  });
});

describe("holderFreshness", () => {
  const at = "2026-10-13T23:00:00.000Z";
  const t = Date.parse(at);
  it("puts the next update one scan after the reading", () => {
    expect(holderFreshness(at, t + 20_000)).toEqual({ last: t, next: t + 60_000 });
  });
  it("says it is due now once that scan is late", () => {
    expect(holderFreshness(at, t + 3 * 60_000)).toEqual({ last: t, next: t + 3 * 60_000 });
  });
  it("has no next update once the coin has gone unscanned for ten minutes", () => {
    expect(holderFreshness(at, t + 10 * 60_000)).toEqual({ last: t, next: null });
  });
});

describe("bubbleNameLines", () => {
  it("keeps a short name on one line, small", () => {
    const fit = bubbleNameLines(40, "Binance");
    expect(fit?.lines).toEqual(["Binance"]);
    expect(fit!.size).toBeLessThanOrEqual(10.5);
    expect(fit!.wide).toBe(false);
  });
  it("wraps a long name at a space onto two lines, clipping the rest, never past the widest", () => {
    const fit = bubbleNameLines(20, "Jupiter Aggregator Authority Wallet")!;
    expect(fit.lines.length).toBe(2);
    expect(fit.lines[0]).toBe("Jupiter");
    expect(fit.lines[1]!.endsWith("…")).toBe(true);
    expect(fit.w).toBeLessThanOrEqual(NAME_MAX_W);
    expect(fit.wide).toBe(true);
  });
  it("keeps a Pump.fun name's quotes, clipped or not", () => {
    expect(bubbleNameLines(40, "degen", true)?.lines).toEqual(['"degen"']);
    const clipped = bubbleNameLines(14, "averyveryverylongusernameindeedyes", true)!.lines;
    expect(clipped[0]!.startsWith('"')).toBe(true);
    expect(clipped[clipped.length - 1]!.endsWith('…"')).toBe(true);
  });
  it("leaves a bubble too small for a name without one", () => {
    expect(bubbleNameLines(10, "Binance")).toBeNull();
  });
});

describe("placeLabels", () => {
  const node = (id: string, x: number, y: number, r: number) =>
    ({ id, kind: "holder", x, y, r }) as unknown as MapNode;
  it("puts a label below its anchor when that is clear", () => {
    const [p] = placeLabels({ nodes: [node("a", 0, 0, 10)], links: [] }, [
      { id: "l", x: 0, y: 0, r: 10, w: 40, h: 16 },
    ]);
    expect(p!.x).toBe(0);
    expect(p!.y).toBeGreaterThan(10);
  });
  it("moves off a bubble sitting under the anchor, and off a line", () => {
    const g = {
      nodes: [node("a", 0, 0, 10), node("b", 0, 40, 20), node("c", 60, 0, 10)],
      links: [{ from: "a", to: "c", cluster: 0 }],
    };
    const [p] = placeLabels(g, [{ id: "l", x: 0, y: 0, r: 10, w: 40, h: 16 }]);
    // Not below (bubble b) and not to the right (the line to c): above.
    expect(p!.y).toBeLessThan(0);
  });
  it("keeps two labels apart", () => {
    const g = { nodes: [node("a", 0, 0, 10)], links: [] };
    const [p, q] = placeLabels(g, [
      { id: "l1", x: 0, y: 0, r: 10, w: 40, h: 16 },
      { id: "l2", x: 0, y: 0, r: 10, w: 40, h: 16 },
    ]);
    const overlap = Math.abs(p!.x - q!.x) * 2 < 80 && Math.abs(p!.y - q!.y) * 2 < 32;
    expect(overlap).toBe(false);
  });
});

describe("same-exchange ties", () => {
  it("ties each holder an exchange funded to the largest of its group, and counts the tile", () => {
    const g = buildGraph({
      linkedHolders: [
        { wallet: A, pct: 5, cexFunder: "EX1" },
        { wallet: B, pct: 3, cexFunder: "EX2" },
        { wallet: C, pct: 2, cexFunder: "EX1" },
        { wallet: D, pct: 1, cexFunder: "EX1" },
      ],
      cexFundedCount: 4,
      cexFundedHolders: 20,
      cexFundedPct: 20,
      top10HolderPct: null,
      top10WalletsChecked: null,
    });
    expect(g.cexLinks).toEqual([
      { from: `h:${C}`, to: `h:${A}`, funder: "EX1" },
      { from: `h:${D}`, to: `h:${A}`, funder: "EX1" },
    ]);
    expect(g.cexCount).toEqual({ linked: 4, of: 20 });
    // Drawn only: the Linked reading and the clusters don't move.
    expect(g.clusters).toEqual([]);
    expect(g.links).toEqual([]);
  });
  it("lists each exchange's holders and share, largest first", () => {
    const g = buildGraph({
      linkedHolders: [
        { wallet: A, pct: 5, cexFunder: "EX1" },
        { wallet: B, pct: 3, cexFunder: "EX2" },
        { wallet: C, pct: 2, cexFunder: "EX1" },
        { wallet: D, pct: 4, cexFunder: "EX2" },
      ],
      top10HolderPct: null,
      top10WalletsChecked: null,
    });
    expect(cexGroupsOf(g).map((x) => [x.funder, x.nodes.length, x.pct])).toEqual([
      ["EX1", 2, 7],
      ["EX2", 2, 7],
    ]);
  });
  it("draws nothing for a holder off the map or on older scans", () => {
    expect(cexLinksOf([{ wallet: A, pct: 5, cexFunder: "EX1" }], [])).toEqual([]);
    expect(
      buildGraph({ linkedHolders: [{ wallet: A, pct: 5 }], top10HolderPct: null, top10WalletsChecked: null })
        .cexLinks,
    ).toEqual([]);
  });
});

describe("colour slots", () => {
  const graph = { clusters: [{}, {}] } as unknown as Parameters<typeof sameTimeSlot>[0];
  it("gives clusters the first slots and same-minute groups the next, so none repeat", () => {
    expect(nodeSlot({ cluster: 1, sameTime: 0 }, graph)).toBe(1);
    expect(sameTimeSlot(graph, 0)).toBe(2);
    expect(nodeSlot({ cluster: null, sameTime: 1 }, graph)).toBe(3);
    expect(nodeSlot({ cluster: null, sameTime: null }, graph)).toBeNull();
    expect(sameTimeSlot(graph, MAP_COLOURS - 2)).toBe(0);
  });
});

describe("cexLayout", () => {
  it("pulls an exchange's holders closer, and leaves the usual layout as it was", () => {
    const holders = [A, B, C, D, F, R].map((w, i) => ({
      wallet: w,
      pct: 6 - i * 0.5,
      ...(w === A || w === R ? { cexFunder: "EX1" } : {}),
    }));
    const g = layoutGraph(
      buildGraph({ linkedHolders: holders, top10HolderPct: null, top10WalletsChecked: null }),
    );
    const at = (graph: typeof g, w: string) => graph.nodes.find((n) => n.wallet === w)!;
    const gap = (graph: typeof g) =>
      Math.hypot(at(graph, A).x - at(graph, R).x, at(graph, A).y - at(graph, R).y);
    const before = { x: at(g, A).x, y: at(g, A).y, gap: gap(g) };
    const pulled = cexLayout(g);
    expect(gap(pulled)).toBeLessThanOrEqual(before.gap);
    expect(gap(pulled)).toBeLessThan(at(pulled, A).r + at(pulled, R).r + 40);
    expect(at(g, A)).toMatchObject({ x: before.x, y: before.y });
  });
});

describe("exchangeName", () => {
  it("cuts a wallet label to the exchange's name", () => {
    expect(exchangeName("Binance Hot Wallet 2")).toBe("Binance");
    expect(exchangeName("Coinbase Hot Wallet 2")).toBe("Coinbase");
    expect(exchangeName("Binance 2")).toBe("Binance");
    expect(exchangeName("Crypto.com Withdrawal")).toBe("Crypto.com");
    expect(exchangeName("OKX")).toBe("OKX");
    expect(exchangeName("Gate.io Deposit #3")).toBe("Gate.io");
  });
});

describe("centreOf", () => {
  it("averages the bubbles' centres", () => {
    expect(
      centreOf([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ]),
    ).toEqual({ x: 5, y: 10 });
  });
});
