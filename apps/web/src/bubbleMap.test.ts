import { describe, expect, it } from "vitest";
import {
  clusterNumberText,
  funderNamed,
  largestSourceOnly,
  mapLinked,
  showsPct,
  kolControl,
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
  alertWideMap,
  fromAlertText,
  sideCounts,
  sideWord,
  bundleOutline,
  regroupLayout,
  kolBundleNodes,
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

  it("takes an earlier holder list whose funders were read over a newer one whose weren't", () => {
    const holders = [{ wallet: A, pct: 12 }];
    const rows = [
      { linkedWalletPct: null, linkedClusters: null, linkedHolders: holders, id: 1 },
      { linkedWalletPct: 0, linkedClusters: null, linkedHolders: holders, id: 2 },
    ];
    expect(pickReading(rows)?.id).toBe(2);
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

describe("bubble map top 50", () => {
  const wide = {
    readAt: "2026-10-14T02:00:00Z",
    holdersRead: 50,
    knownExtra: 1,
    holders: [
      { wallet: A, pct: 12 },
      { wallet: B, pct: 9 },
      { wallet: R, pct: 0.4, rank: 37 },
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

  it("draws an alerted coin's known top-50 wallets in their clusters, with their rank, counts unchanged", () => {
    const g = buildGraph({ ...snapshot, linkedWalletCount: 4, linkedWalletsChecked: 25 } as never);
    const w = buildGraph(withWideMap({ ...snapshot, linkedWalletCount: 4, linkedWalletsChecked: 25 }, wide));
    const r = w.nodes.find((n) => n.wallet === R)!;
    expect(r).toMatchObject({ kind: "holder", cluster: 0, rank: 37 });
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

  it("stands the map kept at the call in for an alert only near it", () => {
    const read = Date.parse(wide.readAt);
    const kept = { ...wide, alertAt: new Date(read - 40_000).toISOString() };
    expect(alertWideMap(kept, read - 40_000)).toBe(kept);
    // A filter alert ten minutes before the call still gets it; one an hour away does not.
    expect(alertWideMap(kept, read - 10 * 60_000)).toBe(kept);
    expect(alertWideMap(kept, read - 60 * 60_000)).toBeNull();
    expect(alertWideMap(null, read)).toBeNull();
    expect(alertWideMap(undefined, read)).toBeNull();
    expect(alertWideMap({ ...kept, holders: [] }, read)).toBeNull();
  });

  it("says how far a reading is from the alert", () => {
    expect(fromAlertText(1_000, 0, "call")).toBe("at the call");
    expect(fromAlertText(40_000, 0, "call")).toBe("40s after the call");
    expect(fromAlertText(0, 180_000, "alert")).toBe("3m before the alert");
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
  it("keeps a word only a few letters too long whole", () => {
    expect(bubbleNameLines(18, "Moonwalker")?.lines).toEqual(["Moonwalker"]);
  });
  it("leaves a bubble too small for a name without one", () => {
    expect(bubbleNameLines(10, "Binance")).toBeNull();
  });
});

describe("placeLabels", () => {
  const node = (id: string, x: number, y: number, r: number) =>
    ({ id, kind: "holder", x, y, r, sameTime: null, flags: [] }) as unknown as MapNode;
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
    // No further apart (both may already sit as close as the bubbles' berth allows).
    expect(gap(pulled)).toBeLessThanOrEqual(before.gap + 1e-3);
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

describe("sideWord", () => {
  const g = { kolWallet: "kol", kolName: "Kol", wallets: [] };
  const n = (wallet: string) => ({ wallet }) as unknown as MapNode;
  it("says side? for one possible side wallet, with or without the KOL's own bubble", () => {
    expect(sideWord([n("a")], g)).toBe("side?");
    expect(sideWord([n("kol"), n("a")], g)).toBe("side?");
  });
  it("says sides? for two or more", () => {
    expect(sideWord([n("kol"), n("a"), n("b")], g)).toBe("sides?");
  });
  it("drops the question mark when every side wallet on the map is one the KOL funded", () => {
    const f = {
      ...g,
      wallets: [
        { wallet: "a", pct: 0, funded: true },
        { wallet: "b", pct: 90 },
      ],
    };
    expect(sideWord([n("kol"), n("a")], f)).toBe("funded");
    expect(sideWord([n("kol"), n("a"), n("b")], f)).toBe("sides?");
  });
  it("says side or sides, with no question mark, for the KOL's Known Sides", () => {
    const k = {
      ...g,
      wallets: [
        { wallet: "a", pct: 100, known: true },
        { wallet: "b", pct: 0, funded: true },
        { wallet: "c", pct: 90 },
      ],
    };
    expect(sideWord([n("kol"), n("a")], k)).toBe("side");
    expect(sideWord([n("a"), n("b")], k)).toBe("sides");
    expect(sideWord([n("a"), n("c")], k)).toBe("sides?");
    expect(sideCounts([n("kol"), n("a"), n("b"), n("c")], k)).toEqual({ known: 1, funded: 1, possible: 1 });
  });
});

describe("bubble % labels", () => {
  it("label every holder down to 0.1% of supply", () => {
    expect(showsPct(0.1)).toBe(true);
    expect(showsPct(0.45)).toBe(true);
    expect(showsPct(12)).toBe(true);
    expect(showsPct(0.09)).toBe(false);
  });
});

describe("kolControl", () => {
  const h = (wallet: string, pct: number, cluster: number | null = null, sameTime: number | null = null) =>
    ({ kind: "holder", wallet, pct, cluster, sameTime }) as unknown as MapNode;
  const graph = {
    nodes: [
      h("kol", 2),
      h("side", 1.5, 0),
      h("mate", 0.5, 0),
      h("min", 0.3, null, 1),
      h("fund", 1, null, 1),
      h("x", 4),
    ],
  };
  it("adds the KOL, its side and funded wallets, and holders sharing their funder or minute", () => {
    const [k] = kolControl(graph, [
      {
        kolWallet: "kol",
        kolName: "Ansem",
        wallets: [
          { wallet: "side", pct: 92 },
          { wallet: "fund", pct: 0, funded: true },
        ],
      },
    ]);
    expect(k!.holds).toBe(true);
    expect(k!.wallets.map((w) => [w.wallet, w.tie])).toEqual([
      ["kol", "kol"],
      ["side", "side"],
      ["fund", "funded"],
      ["mate", "cluster"],
      ["min", "same-minute"],
    ]);
    expect(k!.pct).toBe(5.3);
  });
  it("lists a KOL with no side wallets only when another holder is tied to it", () => {
    expect(kolControl(graph, [], [{ wallet: "x", name: "Solo" }])).toEqual([]);
    const tied = { nodes: [h("k2", 1, 3), h("y", 0.4, 3)] };
    expect(kolControl(tied, [], [{ wallet: "k2", name: "Two" }])[0]!.pct).toBe(1.4);
  });
});

describe("label rooms (user ask 2026-10-15)", () => {
  it("keeps room for a funder's pill right by its diamond, clear of every bubble", () => {
    const g = layoutGraph(buildGraph(snapshot));
    const funder = g.nodes.find((n) => n.kind === "funder")!;
    const spot = g.labelSpots?.get(funder.id);
    expect(spot).toBeDefined();
    // The room's box (about a pill's size) touches no bubble's edge...
    for (const n of g.nodes) {
      const cx = Math.max(spot!.x - 41, Math.min(n.x, spot!.x + 41));
      const cy = Math.max(spot!.y - 9, Math.min(n.y, spot!.y + 9));
      expect(Math.hypot(cx - n.x, cy - n.y)).toBeGreaterThanOrEqual(n.r);
    }
    // ...and sits within a short leader of the diamond.
    const gx = Math.max(0, Math.abs(spot!.x - funder.x) - 41);
    const gy = Math.max(0, Math.abs(spot!.y - funder.y) - 9);
    expect(Math.hypot(gx, gy) - funder.r).toBeLessThan(40);
  });
  it("puts a pill in its room when the room is clear", () => {
    const g = layoutGraph(buildGraph(snapshot));
    const funder = g.nodes.find((n) => n.kind === "funder")!;
    const [p] = placeLabels(g, [{ id: funder.id, x: funder.x, y: funder.y, r: funder.r, w: 60, h: 16 }]);
    const spot = g.labelSpots!.get(funder.id)!;
    expect(Math.hypot(p!.x - spot.x, p!.y - spot.y)).toBeLessThan(40);
  });
  it("keeps a KOL's pill by the KOL, its bundle drawn in together", () => {
    const g = layoutGraph(buildGraph({ ...snapshot, linkedHolders: [{ wallet: R, pct: 3 }] }));
    const kols = kolControl(g, [{ kolWallet: R, kolName: "Ansem", wallets: [{ wallet: D, pct: 4 }] }]);
    const pulled = regroupLayout(g, { kols });
    const { kol, members } = kolBundleNodes(pulled, kols[0]!);
    expect(kol?.wallet).toBe(R);
    expect(members.map((n) => n.wallet).sort()).toEqual([C, D, R].sort());
    const spot = pulled.labelSpots?.get(`kol:${R}`);
    expect(spot).toBeDefined();
    expect(Math.hypot(spot!.x - kol!.x, spot!.y - kol!.y)).toBeLessThan(kol!.r + 120);
  });
});

describe("bundleOutline", () => {
  it("grows each bubble and joins them along the shortest gaps", () => {
    const o = bundleOutline([
      { x: 0, y: 0, r: 10 },
      { x: 100, y: 0, r: 10 },
      { x: 30, y: 0, r: 5 },
    ]);
    expect(o.circles.map((c) => c.r)).toEqual([24, 24, 19]);
    // Two bands for three bubbles: 0-2 and 2-1, never the long 0-1.
    expect(o.bands).toHaveLength(2);
    expect(o.bands.some((b) => Math.abs(b.x1 - b.x2) === 100)).toBe(false);
  });
  it("draws nothing for a lone bubble", () => {
    expect(bundleOutline([{ x: 0, y: 0, r: 10 }])).toEqual({ circles: [], bands: [] });
  });
});

describe("largestSourceOnly (user ask 2026-10-15)", () => {
  const g = (kind: string, pct: number, wallets: string[]) => ({ kind, pct, wallets });
  it("lists a group under two kinds once, under the larger", () => {
    const cluster = g("cluster", 3, ["a", "b", "c"]);
    const minute = g("same-minute", 2, ["a", "b"]);
    const other = g("same-minute", 1, ["x", "y"]);
    expect(largestSourceOnly([cluster, minute, other])).toEqual([cluster, other]);
  });
  it("keeps the KOL bundle over the cluster it takes in", () => {
    const cluster = g("cluster", 7.9, ["a", "b"]);
    const kol = g("kol", 13.8, ["k", "a", "b"]);
    expect(largestSourceOnly([cluster, kol])).toEqual([kol]);
  });
  it("breaks a tie on share by wallet count", () => {
    const minute = g("same-minute", 2, ["a", "b"]);
    const cluster = g("cluster", 2, ["a", "b", "c"]);
    expect(largestSourceOnly([minute, cluster])).toEqual([cluster]);
  });
  it("keeps overlapping groups of the same kind", () => {
    const k1 = g("kol", 5, ["a", "b"]);
    const k2 = g("kol", 4, ["b", "c"]);
    expect(largestSourceOnly([k1, k2])).toEqual([k1, k2]);
  });
});

describe("mapLinked (user ask 2026-10-15)", () => {
  const node = (wallet: string, pct: number, cluster: number | null, rank?: number) =>
    ({ kind: "holder", wallet, pct, cluster, ...(rank ? { rank } : {}) }) as MapNode;
  const graph = (nodes: MapNode[], holdersRead: number | null = null) => ({
    nodes,
    linkedCount: { linked: 2, of: 25 },
    linkedPct: 3,
    scanLinked: new Set(["a", "b"]),
    holdersRead,
  });
  it("keeps the scan's reading when the map adds nothing", () => {
    const g = graph([node("a", 2, 0), node("b", 1, 0), node("c", 5, null)]);
    expect(mapLinked(g, [])).toEqual({ count: { linked: 2, of: 25 }, pct: 3 });
  });
  it("counts holders in a KOL's bundle", () => {
    const g = graph([node("a", 2, 0), node("b", 1, 0), node("k", 5, null), node("s", 1.5, null)]);
    const kols = [{ wallets: [{ wallet: "k" }, { wallet: "s" }, { wallet: "a" }] }];
    expect(mapLinked(g, kols as never)).toEqual({ count: { linked: 4, of: 25 }, pct: 9.5 });
  });
  it("counts out of every holder read once a linked holder ranks past the top 25", () => {
    const g = graph([node("a", 2, 0), node("b", 1, 0), node("w", 0.4, 0, 31)], 50);
    expect(mapLinked(g, [])).toEqual({ count: { linked: 3, of: 50 }, pct: 3.4 });
  });
});

describe("funderNamed (user ask 2026-10-15)", () => {
  const graph = {
    clusters: [{ funder: "f1" }, { funder: "f2" }, { funder: "h" }, { funder: "r" }],
    nodes: [
      { kind: "funder", wallet: "f1", flags: [] },
      { kind: "funder", wallet: "f2", flags: [] },
      { kind: "holder", wallet: "h", flags: [] },
      { kind: "funder", wallet: "r", flags: ["risky"] },
    ],
  } as never;
  const names = { f2: { name: "Jupiter", source: "identity" } } as const;
  it("names only a known funder, a holder, or one labeled anyway", () => {
    expect(funderNamed(graph, "f1", names)).toBe(false);
    expect(funderNamed(graph, "f2", names)).toBe(true);
    expect(funderNamed(graph, "h", names)).toBe(true);
    expect(funderNamed(graph, "r", names)).toBe(true);
  });
  it("numbers the cluster of an unknown funder", () => {
    expect(clusterNumberText(graph, 0, names)).toBe("Cluster 1");
    expect(clusterNumberText(graph, 1, names)).toBeNull();
  });
});
