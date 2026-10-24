import { describe, expect, it } from "vitest";
import { holderStatusText } from "./components/Freshness";
import {
  tiedHolders,
  clusterNumberText,
  funderNamed,
  largestSourceOnly,
  mapLinked,
  showsPct,
  kolControl,
  kolBundledShare,
  bubbleNameLines,
  NAME_MAX_W,
  placeLabels,
  exchangeName,
  centreOf,
  withoutTransfers,
  wideWithoutTransfers,
  type MapNode,
  type BubbleGraph,
  markerSpot,
  stretchWide,
  cexGroupsOf,
  cexLayout,
  cexLinksOf,
  MAP_COLOURS,
  nodeSlot,
  sameTimeSlot,
  buildGraph,
  linkedCount,
  linkedCountText,
  sameTimeCount,
  clusterHalos,
  graphBounds,
  hasHolderList,
  firstReadAfter,
  holderBadgeAt,
  holderFreshness,
  holderShownAt,
  HOLDER_SCAN_GONE_MS,
  HOLDER_STREAMED_READ_MS,
  layoutGraph,
  positionsOf,
  pickReading,
  liveWideFor,
  mapBadgeFreshness,
  withWideMap,
  alertWideMap,
  fromAlertText,
  sideCounts,
  sideWord,
  bundleOutline,
  regroupLayout,
  kolBundleNodes,
  transferCurve,
  transferRoutes,
  routePoints,
  transfersOfNode,
  needsRegroup,
  transferWidth,
  linkKey,
  linkRoutes,
  sameTimeTies,
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

  it("adds no flagged wallet off the list when the reading has a holder list of its own", () => {
    // trunoest held 2.86% at the call and sold out since: the current list doesn't have it.
    const listed = { ...snapshot, linkedHolders: [{ wallet: A, pct: 12 }] };
    const g = buildGraph(listed, [
      { wallet: R, tags: ["kol"], score: null, dumps: null, heldPct: 2.86, kol: "trunoest" },
    ]);
    expect(g.nodes.some((n) => n.wallet === R)).toBe(false);
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

  it("redraws from the last layout without moving the bubbles far", () => {
    const first = layoutGraph(buildGraph(snapshot));
    const prev = positionsOf(first);
    const again = layoutGraph(buildGraph(snapshot), 320, { prev });
    for (const n of again.nodes) {
      const was = prev.get(n.id)!;
      expect(Math.hypot(n.x - was.x, n.y - was.y)).toBeLessThan(n.r);
    }
    for (let i = 0; i < again.nodes.length; i += 1) {
      for (let j = i + 1; j < again.nodes.length; j += 1) {
        const a = again.nodes[i]!;
        const b = again.nodes[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    }
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

  it("takes a newer checked holder list over an older reading's clusters", () => {
    const holders = [{ wallet: A, pct: 12 }];
    const rows = [
      { linkedWalletPct: 0, linkedClusters: null, linkedHolders: holders, id: 1 },
      { linkedWalletPct: 20, linkedClusters: snapshot.linkedClusters, linkedHolders: holders, id: 2 },
    ];
    expect(pickReading(rows)?.id).toBe(1);
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

describe("live top 50 over a scan", () => {
  const holders = [{ wallet: A, pct: 12 }];
  const wide = {
    readAt: "2026-10-14T02:00:00Z",
    holdersRead: 50,
    knownExtra: 0,
    holders,
    clusters: [],
    sameTimeClusters: [],
  };
  const scan = (takenAt: string, list = true) => ({
    takenAt,
    linkedClusters: null,
    linkedHolders: list ? holders : null,
  });

  it("draws a top 50 read near the scan", () => {
    expect(liveWideFor(scan("2026-10-14T02:10:00Z"), wide)).toBe(wide);
  });

  it("leaves off a top 50 read long before the scan, which has its own list", () => {
    expect(liveWideFor(scan("2026-10-17T02:00:00Z"), wide)).toBeNull();
  });

  it("keeps an old top 50 when the scan has no list of its own to draw", () => {
    expect(liveWideFor(scan("2026-10-17T02:00:00Z", false), wide)).toBe(wide);
  });

  it("keeps the top 50 of a quiet coin whose top 25 is from the same chain read", () => {
    // No trade since the read: the worker keeps both lists, and scans keep landing.
    const quiet = { ...scan("2026-10-14T02:30:00Z"), holderChainReadAt: "2026-10-14T02:00:00Z" };
    expect(liveWideFor(quiet, wide)).toBe(wide);
  });

  it("leaves off a top 50 the top 25 has been re-read past", () => {
    const reread = { ...scan("2026-10-14T02:30:00Z"), holderChainReadAt: "2026-10-14T02:20:00Z" };
    expect(liveWideFor(reread, wide)).toBeNull();
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
  const reads = (nextRead: number) => ({ nextRead, everyMs: 15_000 });
  it("shows the next list at the view's first read after the worker writes it", () => {
    expect(holderFreshness({ takenAt: at }, t + 20_000, reads(t + 25_000))).toEqual({
      last: t,
      due: t + 60_000,
      next: t + 70_000,
      late: false,
    });
    expect(holderFreshness({ takenAt: at }, t + 50_000, reads(t + 60_000)).next).toBe(t + 60_000);
  });
  it("counts to the next read once a read since the list was due found none", () => {
    expect(holderFreshness({ takenAt: at }, t + 3 * 60_000, reads(t + 3 * 60_000 + 4_000))).toEqual({
      last: t,
      due: t + 60_000,
      next: t + 3 * 60_000 + 4_000,
      late: true,
    });
    // Due, but the view hasn't looked since: still the next update, not a re-check.
    expect(holderFreshness({ takenAt: at }, t + 65_000, reads(t + 70_000)).late).toBe(false);
  });
  it("does not treat a streamed balance as a new read of the holder list", () => {
    // 2026-10-21 user ask: the list was read at `chain`. A later streamed balance and the scan
    // row that carried it are not that read. The countdown stays on the chain read, so it is
    // already late instead of starting another minute from the balance.
    const chain = "2026-10-13T23:00:00.000Z";
    const balances = "2026-10-13T23:04:50.000Z";
    const scan = "2026-10-13T23:04:55.000Z";
    const now = Date.parse(scan) + 5_000;
    expect(
      holderFreshness(
        { takenAt: scan, holdersAt: chain, holderBalancesAt: balances, holderChainReadAt: chain },
        now,
        reads(now + 4_000),
      ),
    ).toMatchObject({
      last: Date.parse(chain),
      // The stream has moved shares, so the next chain read is five minutes out, not a minute.
      due: Date.parse(chain) + HOLDER_STREAMED_READ_MS,
      late: false,
    });
    // The map's badge is the top-50 read, not a later balance or the scan row.
    expect(
      holderBadgeAt({ takenAt: scan, holderBalancesAt: balances, holderChainReadAt: chain }, chain),
    ).toBe(Date.parse(chain));
    // A balance with no chain read is not the badge. The scan's own time is.
    expect(holderBadgeAt({ takenAt: scan, holderBalancesAt: balances })).toBe(Date.parse(scan));
  });
  it("dates a list carried onto a later scan by when it was written", () => {
    const scan = "2026-10-13T23:04:00.000Z";
    expect(
      holderFreshness({ takenAt: scan, holdersAt: at }, t + 4 * 60_000, reads(t + 4 * 60_000 + 9_000)),
    ).toEqual({
      last: t,
      due: t + 60_000,
      next: t + 4 * 60_000 + 9_000,
      late: true,
    });
  });
  it("has no countdown for a view that doesn't follow the scans", () => {
    expect(holderFreshness({ takenAt: at }, t + 20_000)).toEqual({
      last: t,
      due: t + 60_000,
      next: null,
      late: false,
    });
  });
  it("does not call a coin unscanned at twelve minutes while its scans are still inside the window", () => {
    const fresh = holderFreshness({ takenAt: at }, t + 12 * 60_000, reads(t + 12 * 60_000 + 1_000));
    expect(fresh.due).not.toBeNull();
    expect(fresh.next).not.toBeNull();
  });
  it("has no next update once scans have stopped", () => {
    expect(
      holderFreshness({ takenAt: at }, t + HOLDER_SCAN_GONE_MS, reads(t + HOLDER_SCAN_GONE_MS + 1_000)),
    ).toEqual({
      last: t,
      due: null,
      next: null,
      late: false,
    });
  });
  it("follows the chain-read schedule and does not move the shown time on a balance", () => {
    const chain = at;
    const balances = new Date(t + 4 * 60_000).toISOString();
    const scan = new Date(t + 4 * 60_000).toISOString();
    const next = new Date(t + HOLDER_STREAMED_READ_MS).toISOString();
    const now = t + 4 * 60_000;
    const fresh = holderFreshness(
      { takenAt: scan, holderChainReadAt: chain, holderBalancesAt: balances, holderNextReadAt: next },
      now,
      reads(now + 4_000),
    );
    expect(fresh.last).toBe(t);
    expect(fresh.due).toBe(t + HOLDER_STREAMED_READ_MS);
    expect(fresh.late).toBe(false);
  });
  it("keeps a quiet coin on its schedule instead of saying it is no longer scanned", () => {
    const chain = at;
    const now = t + 20 * 60_000;
    const scan = new Date(now).toISOString();
    const next = new Date(now + HOLDER_STREAMED_READ_MS).toISOString();
    const fresh = holderFreshness(
      { takenAt: scan, holderChainReadAt: chain, holderBalancesAt: chain, holderNextReadAt: next },
      now,
      reads(now + 4_000),
    );
    expect(fresh.last).toBe(t);
    expect(fresh.due).toBe(now + HOLDER_STREAMED_READ_MS);
    expect(fresh.next).not.toBeNull();
  });

  it("does not let a balance tick read as live or reset the countdown age", () => {
    const chain = at;
    const balances = new Date(t + 4 * 60_000).toISOString();
    const scan = balances;
    const next = new Date(t + HOLDER_STREAMED_READ_MS).toISOString();
    const now = t + 4 * 60_000 + 1_000;
    const reading = {
      takenAt: scan,
      holderChainReadAt: chain,
      holderBalancesAt: balances,
      holderNextReadAt: next,
    };
    expect(holderShownAt(reading)).toBe(t);
    const fresh = holderFreshness(reading, now, reads(now + 4_000));
    const text = holderStatusText(now, fresh.last, fresh.due);
    expect(text).toBe("4m 01s ago · Next update in 0:59");
    expect(text.toLowerCase()).not.toContain("live");
    expect(holderStatusText(now, fresh.last, null, { live: true })).toBe("Live");
  });
});

describe("firstReadAfter", () => {
  it("takes the first read on the beat at or after the moment", () => {
    expect(firstReadAfter(100, 100, 15)).toBe(100);
    expect(firstReadAfter(90, 100, 15)).toBe(100);
    expect(firstReadAfter(101, 100, 15)).toBe(115);
    expect(firstReadAfter(130, 100, 15)).toBe(130);
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

describe("holder transfers", () => {
  const holders = [
    { wallet: A, pct: 5 },
    { wallet: B, pct: 3 },
    { wallet: C, pct: 2 },
  ];
  it("draws a sender-to-receiver arrow for each pair on the map, largest first, never in Linked", () => {
    const g = buildGraph({
      linkedHolders: holders,
      top10HolderPct: null,
      top10WalletsChecked: null,
      linkedWalletPct: 0,
      transferredSupplyPct: 4.5,
      transferWalletCount: 3,
      transferHoldersChecked: 25,
      holderTransfers: [
        { from: A, to: B, pct: 1.5, count: 2, lastAtMs: 1_000 },
        { from: C, to: A, pct: 3, count: 1 },
        // Off the map: left out.
        { from: A, to: "elsewhere", pct: 9, count: 1 },
      ],
    });
    expect(g.transferLinks).toEqual([
      { from: `h:${C}`, to: `h:${A}`, pct: 3, count: 1, lastAtMs: null },
      { from: `h:${A}`, to: `h:${B}`, pct: 1.5, count: 2, lastAtMs: 1_000 },
    ]);
    expect(g.transferPct).toBe(4.5);
    expect(g.transferCount).toEqual({ linked: 3, of: 25 });
    expect(g.linkedPct).toBe(0);
    expect(g.links).toEqual([]);
    expect(transfersOfNode(g, `h:${A}`)).toEqual({ sent: 1.5, sentTo: 1, got: 3, gotFrom: 1 });
    expect(needsRegroup({ transfers: true })).toBe(true);
  });
  it("is unread on older scans", () => {
    const g = buildGraph({ linkedHolders: holders, top10HolderPct: null, top10WalletsChecked: null });
    expect(g.transferLinks).toEqual([]);
    expect(g.transferPct).toBeNull();
    expect(g.transferCount).toBeNull();
  });
  it("routes an arrow round a bubble in its way, and keeps a two-way pair's arcs apart", () => {
    const node = (id: string, x: number, y: number, r: number) =>
      ({ id, x, y, r, flags: [], trait: null }) as unknown as MapNode;
    const a = node("a", 0, 0, 10);
    const b = node("b", 120, 0, 10);
    // A bubble right where the plain bow (to the sender's right, +y here) passes.
    const block = node("x", 60, 24, 12);
    const one = transferRoutes({
      nodes: [a, b, block],
      transferLinks: [{ from: "a", to: "b", pct: 1, count: 1, lastAtMs: null }],
    });
    const r = one.get("a>b")!;
    expect(r.cy).toBeLessThan(0);
    expect(routePoints(r).every((p) => Math.hypot(p.x - block.x, p.y - block.y) > block.r)).toBe(true);
    const two = transferRoutes({
      nodes: [a, b],
      transferLinks: [
        { from: "a", to: "b", pct: 1, count: 1, lastAtMs: null },
        { from: "b", to: "a", pct: 1, count: 1, lastAtMs: null },
      ],
    });
    // The two arrows run as two lanes of one bundle, side by side, apart all along their middles.
    const there = routePoints(two.get("a>b")!, 4);
    const back = routePoints(two.get("b>a")!, 4).reverse();
    for (let i = 2; i < there.length - 2; i += 1) {
      const p = there[i]!;
      const gap = Math.min(...back.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
      expect(gap).toBeGreaterThan(transferWidth(1) * 1.5);
    }
  });
  it("lays the map out with no bubble under a transfer arrow, and no pill on one", () => {
    const g = buildGraph({
      linkedHolders: [
        { wallet: A, pct: 5 },
        { wallet: B, pct: 3 },
        { wallet: C, pct: 2 },
        ...Array.from({ length: 12 }, (_, i) => ({ wallet: `w${i}`, pct: 1 })),
      ],
      top10HolderPct: null,
      top10WalletsChecked: null,
      holderTransfers: [
        { from: A, to: B, pct: 2, count: 1 },
        { from: B, to: C, pct: 1, count: 1 },
        { from: C, to: A, pct: 1, count: 1 },
      ],
    });
    const map = regroupLayout(g, { transfers: true });
    const routes = transferRoutes(map);
    for (const [key, r] of routes) {
      const [from, to] = key.split(">");
      for (const n of map.nodes) {
        if (n.id === from || n.id === to) continue;
        for (const p of routePoints(r)) expect(Math.hypot(p.x - n.x, p.y - n.y)).toBeGreaterThan(n.r);
      }
    }
    const [placed] = placeLabels(map, [{ id: "pill", x: 0, y: 0, r: 0, w: 60, h: 16 }], routes);
    for (const r of routes.values()) {
      for (const p of routePoints(r)) {
        const inside = Math.abs(p.x - placed!.x) < placed!.w / 2 && Math.abs(p.y - placed!.y) < placed!.h / 2;
        expect(inside).toBe(false);
      }
    }
  });
  it("bends each direction to its own side and stops at the bubbles' edges", () => {
    const a = { x: 0, y: 0, r: 10 };
    const b = { x: 100, y: 0, r: 20 };
    const there = transferCurve(a, b);
    const back = transferCurve(b, a);
    expect(Math.sign(there.cy)).toBe(-Math.sign(back.cy));
    expect(Math.hypot(there.x1 - a.x, there.y1 - a.y)).toBeCloseTo(a.r + 1.5);
    expect(Math.hypot(there.x2 - b.x, there.y2 - b.y)).toBeCloseTo(b.r + 2);
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
  it("draws the reader's User Tracked wallet as a KOL's bundle, named theirs, out of KOL Bundled %", () => {
    const groups = [{ kolWallet: "kol", kolName: "Roster", wallets: [{ wallet: "side", pct: 92 }] }];
    const [k] = kolControl(graph, groups, [{ wallet: "kol", name: "Mine", tracked: true }]);
    expect(k).toMatchObject({ kolWallet: "kol", kolName: "Mine", tracked: true });
    expect(kolBundledShare([k!])).toBe(0);
    // A roster KOL's name from the list keeps the group's own name and kind.
    const [r] = kolControl(graph, groups, [{ wallet: "kol", name: "Roster" }]);
    expect(r!.tracked).toBeUndefined();
    expect(kolBundledShare([r!])).toBe(r!.pct);
  });
  it("lists a KOL with no side wallets only when another holder is tied to it", () => {
    expect(kolControl(graph, [], [{ wallet: "x", name: "Solo" }])).toEqual([]);
    const tied = { nodes: [h("k2", 1, 3), h("y", 0.4, 3)] };
    expect(kolControl(tied, [], [{ wallet: "k2", name: "Two" }])[0]!.pct).toBe(1.4);
  });
  it("takes in the holders its bundle sent the coin to, and on from there, past dust", () => {
    const n = (wallet: string, pct: number) =>
      ({
        id: `h:${wallet}`,
        kind: "holder",
        wallet,
        pct,
        cluster: null,
        sameTime: null,
      }) as unknown as MapNode;
    const g = { nodes: [n("kol", 2), n("side", 0.8), n("r1", 0.8), n("r2", 0.7), n("dust", 0.5), n("x", 3)] };
    const sides = [{ kolWallet: "kol", kolName: null, wallets: [{ wallet: "side", pct: 50 }] }];
    const transfers = [
      { from: "h:side", to: "h:r1", pct: 0.8 },
      { from: "h:r1", to: "h:r2", pct: 0.7 },
      { from: "h:side", to: "h:dust", pct: 0.01 },
      { from: "h:x", to: "h:kol", pct: 1 },
    ];
    const [k] = kolControl(g, sides, [], transfers);
    expect(k!.wallets.map((w) => [w.wallet, w.tie])).toEqual([
      ["kol", "kol"],
      ["side", "side"],
      ["r1", "transfer"],
      ["r2", "transfer"],
    ]);
    expect(kolControl(g, sides)[0]!.pct).toBe(2.8);
    // An exchange's transfers link no one: r1 as an exchange stops the chain at the bundle.
    const cex = kolControl(g, sides, [], transfers, undefined, (w) => w === "r1");
    expect(cex[0]!.wallets.map((w) => w.wallet)).toEqual(["kol", "side"]);
  });
  it("steps out by funding alone, leaving out a wallet that sent into the bundle", () => {
    const n = (wallet: string, pct: number, cluster: number | null) =>
      ({ id: `h:${wallet}`, kind: "holder", wallet, pct, cluster, sameTime: null }) as unknown as MapNode;
    // bait sent side the coin, so the drawn cluster 0 holds both; funding alone ties side to mate.
    const g = { nodes: [n("kol", 2, null), n("side", 1, 0), n("mate", 0.5, 0), n("bait", 3, 0)] };
    const sides = [{ kolWallet: "kol", kolName: null, wallets: [{ wallet: "side", pct: 50 }] }];
    const funding = [
      {
        wallets: [
          { wallet: "side", pct: 1 },
          { wallet: "mate", pct: 0.5 },
        ],
      },
    ];
    expect(kolControl(g, sides)[0]!.pct).toBe(6.5);
    const [k] = kolControl(g, sides, [], [{ from: "h:bait", to: "h:side", pct: 1 }], funding);
    expect(k!.wallets.map((w) => w.wallet)).toEqual(["kol", "side", "mate"]);
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
  it("counts a same-minute holder the scan counted once, also in a KOL's bundle (audit 2026-10-16)", () => {
    // K (a KOL) and A were funded in the same minute; the scan counted both: 2/25, 5%.
    const minute = (count: number | undefined) =>
      buildGraph({
        linkedWalletPct: 5,
        linkedWalletCount: count,
        linkedWalletsChecked: 25,
        linkedClusters: [],
        linkedHolders: [
          { wallet: A, pct: 3 },
          { wallet: B, pct: 2 },
          { wallet: C, pct: 1 },
          { wallet: D, pct: 1 },
        ],
        sameTimeFundedPct: 5,
        sameTimeClusters: [
          {
            atMs: 1_000,
            spanMs: 20_000,
            pct: 5,
            wallets: [
              { wallet: A, pct: 3, fundedAtMs: 1_000, funder: F },
              { wallet: B, pct: 2, fundedAtMs: 21_000, funder: R },
            ],
          },
        ],
      } as never);
    const g = minute(2);
    const kols = kolControl(g, [], [{ wallet: A, name: "Kol" }]);
    expect(kols[0]!.wallets.map((w) => w.wallet).sort()).toEqual([A, B]);
    expect(mapLinked(g, kols)).toEqual({ count: { linked: 2, of: 25 }, pct: 5 });
    // A scan from before same-minute holders counted in Linked: the map still adds them.
    const old = minute(0);
    expect(mapLinked(old, kolControl(old, [], [{ wallet: A, name: "Kol" }])).count).toEqual({
      linked: 2,
      of: 25,
    });
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

describe("withoutTransfers", () => {
  const snap = {
    linkedWalletPct: 30,
    linkedWalletCount: 6,
    linkedClusters: [{ funder: "a", wallets: [], pct: 30, creatorLinked: false, transfers: 2 }],
    kolBundledPct: 25,
    bundledSupplyPct: 40,
    bundledSupplyCount: 5,
    linkedWalletPctExTransfers: 20,
    linkedWalletCountExTransfers: 4,
    linkedClustersExTransfers: [{ funder: "a", wallets: [], pct: 20, creatorLinked: false }],
    kolBundledPctExTransfers: 15,
    bundledSupplyPctExTransfers: 30,
    bundledSupplyCountExTransfers: 3,
  } as unknown as Parameters<typeof withoutTransfers>[0];

  it("shows the figures without transfers", () => {
    expect(withoutTransfers(snap)).toMatchObject({
      linkedWalletPct: 20,
      linkedWalletCount: 4,
      linkedClusters: [{ pct: 20 }],
      kolBundledPct: 15,
      bundledSupplyPct: 30,
      bundledSupplyCount: 3,
    });
  });

  it("keeps a snapshot read before the figures were kept", () => {
    const old = { ...snap, linkedWalletPctExTransfers: null };
    expect(withoutTransfers(old)).toBe(old);
  });
});

describe("wideWithoutTransfers", () => {
  const wide = {
    readAt: "2026-10-16T00:00:00Z",
    holdersRead: 50,
    knownExtra: 0,
    holders: [],
    clusters: [{ funder: "a", wallets: [], pct: 30, creatorLinked: false, transfers: 1 }],
    clustersExTransfers: [{ funder: "b", wallets: [], pct: 10, creatorLinked: false }],
    sameTimeClusters: [],
  };

  it("draws the clusters without transfers when the map kept them", () => {
    expect(wideWithoutTransfers(wide)!.clusters).toEqual(wide.clustersExTransfers);
    const plain = { ...wide, clustersExTransfers: undefined };
    expect(wideWithoutTransfers(plain)).toBe(plain);
    expect(wideWithoutTransfers(null)).toBeNull();
  });
});

describe("markerSpot", () => {
  it("sits on the rim at the lower corner when nothing is in the way", () => {
    const p = markerSpot(0, 0, 20, 6.5, 1, [{ x: 0, y: 0, w: 16, h: 8 }]);
    expect(p.x).toBeCloseTo(20 * Math.SQRT1_2);
    expect(p.y).toBeCloseTo(20 * Math.SQRT1_2);
    expect(markerSpot(0, 0, 20, 6.5, -1, []).x).toBeLessThan(0);
  });

  it("moves off a name that reaches the corner (user ask 2026-10-16)", () => {
    const name = { x: 0, y: 8, w: 44, h: 16 };
    const p = markerSpot(0, 0, 20, 6.5, 1, [name]);
    const dx = Math.max(Math.abs(p.x - name.x) - name.w / 2, 0);
    const dy = Math.max(Math.abs(p.y - name.y) - name.h / 2, 0);
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(6.5);
  });
});

describe("stretchWide", () => {
  const node = (id: string, x: number, y: number) =>
    ({ id, kind: "holder", x, y, r: 10, cluster: null, sameTime: null, flags: [] }) as unknown as MapNode;
  const graph = (nodes: MapNode[]) => ({ nodes, links: [], clusters: [] }) as unknown as BubbleGraph;

  it("spreads a square map sideways toward a wide box, up to its cap", () => {
    const g = graph([node("a", 0, 0), node("b", 100, 100)]);
    const out = stretchWide(g, 3);
    expect(out.nodes[1]!.x - out.nodes[0]!.x).toBeCloseTo(100 * 1.45, 0);
    expect(out.nodes[1]!.y).toBe(100);
  });

  it("leaves a map that is already wide enough as it is", () => {
    const g = graph([node("a", 0, 0), node("b", 300, 20)]);
    expect(stretchWide(g, 1.2)).toBe(g);
  });
});

describe("tiedHolders", () => {
  const clusters = [
    {
      funder: "f",
      wallets: [
        { wallet: "a", pct: 5 },
        { wallet: "b", pct: 3 },
      ],
      pct: 8,
      creatorLinked: true,
    },
  ];
  it("takes the holders the scan marked, not their whole cluster", () => {
    const s = {
      linkedClusters: clusters,
      linkedHolders: [
        { wallet: "a", pct: 5, creatorTied: true },
        { wallet: "b", pct: 3 },
      ],
      linkedCreatorPct: 5,
    };
    expect([...tiedHolders(s)]).toEqual(["a"]);
  });
  it("falls back on the cluster on a scan from before the marks", () => {
    const s = {
      linkedClusters: clusters,
      linkedHolders: [
        { wallet: "a", pct: 5 },
        { wallet: "b", pct: 3 },
      ],
      linkedCreatorPct: 5,
    };
    expect([...tiedHolders(s)].sort()).toEqual(["a", "b"]);
    expect([...tiedHolders({ ...s, linkedCreatorPct: 0 })]).toEqual([]);
  });
});

describe("link bundles", () => {
  const node = (id: string, x: number, y: number, r: number, extra: Partial<MapNode> = {}) =>
    ({ id, x, y, r, flags: [], trait: null, cluster: null, sameTime: null, ...extra }) as unknown as MapNode;

  it("runs a funding tie and transfers between one pair as side-by-side lanes, arrows on the edges", () => {
    const a = node("a", 0, 0, 14, { cluster: 0 });
    const b = node("b", 140, 0, 14, { cluster: 0, hub: true });
    const { routes } = linkRoutes(
      {
        nodes: [a, b],
        links: [{ from: "a", to: "b", cluster: 0 }],
        sameTimeLinks: [],
        transferLinks: [
          { from: "a", to: "b", pct: 1, count: 1, lastAtMs: null },
          { from: "b", to: "a", pct: 0.5, count: 1, lastAtMs: null },
        ],
      },
      { transfers: true },
    );
    const mid = (k: string) => routePoints(routes.get(k)!, 2);
    const at = (k: string) => {
      const pts = mid(k);
      return pts[Math.floor(pts.length / 2)]!;
    };
    const there = at(linkKey("xfer", "a", "b"));
    const fund = at(linkKey("fund", "a", "b"));
    const back = at(linkKey("xfer", "b", "a"));
    // Across the bundle in order: the arrow out, the funding tie, the arrow back; none on another.
    expect(Math.sign(fund.y - there.y)).toBe(Math.sign(back.y - fund.y));
    expect(Math.abs(fund.y - there.y)).toBeGreaterThan(3);
    expect(Math.abs(back.y - fund.y)).toBeGreaterThan(3);
    // Each lane leaves and reaches its bubbles at the rim, not their centres.
    for (const r of routes.values()) {
      expect(Math.hypot(r.x1 - a.x, r.y1 - a.y)).toBeGreaterThan(a.r - 2);
      expect(Math.hypot(r.x2 - b.x, r.y2 - b.y) || Math.hypot(r.x1 - b.x, r.y1 - b.y)).toBeGreaterThan(
        b.r - 2,
      );
    }
    // An arrow keeps its way: it ends at its receiver.
    const r = routes.get(linkKey("xfer", "b", "a"))!;
    expect(Math.hypot(r.x2 - a.x, r.y2 - a.y)).toBeLessThan(a.r + 3);
  });

  it("bows a lone tie round a bubble in its way", () => {
    const a = node("a", 0, 0, 10);
    const b = node("b", 160, 0, 10, { hub: true });
    // Right where the usual bow passes (to the holder's right going to its funder: -y here).
    const block = node("x", 80, -12, 12);
    const { routes } = linkRoutes({
      nodes: [a, b, block],
      links: [{ from: "a", to: "b", cluster: 0 }],
      sameTimeLinks: [],
      transferLinks: [],
    });
    const pts = routePoints(routes.get(linkKey("fund", "a", "b"))!);
    expect(pts.every((p) => Math.hypot(p.x - block.x, p.y - block.y) > block.r)).toBe(true);
  });

  it("draws a same-minute group's ties only where its clusters don't already join it, nearest first", () => {
    const n1 = node("h1", 0, 0, 10, { cluster: 0, sameTime: 0 });
    const n2 = node("h2", 40, 0, 10, { cluster: 0, sameTime: 0 });
    const n3 = node("h3", 120, 0, 10, { sameTime: 0 });
    const n4 = node("h4", 300, 0, 10, { sameTime: 0 });
    // The scan's ties: every holder to the first funded (h1).
    const ties = sameTimeTies({
      nodes: [n1, n2, n3, n4],
      sameTimeLinks: ["h2", "h3", "h4"].map((from) => ({ from, to: "h1", group: 0 })),
    });
    const pairs = ties.map((t) => [t.from, t.to].sort().join("-")).sort();
    // h1-h2 share a cluster: no tie. h3 joins by h2 (nearest), h4 by h3.
    expect(pairs).toEqual(["h2-h3", "h3-h4"]);
  });
});

describe("bubble map badge on a held map", () => {
  const fresh = { last: 100_000, next: 160_000 };

  it("dates the map drawn, not the newer reading behind it", () => {
    // The map is held an hour between redraws: it was drawn at 0 from a list read at 0.
    const b = mapBadgeFreshness(fresh, 0, { shownAt: 0, everyMs: 3_600_000 });
    expect(b.last).toBe(0);
    expect(b.next).toBe(3_600_000);
  });

  it("counts to the list's next read when the redraw comes sooner", () => {
    expect(mapBadgeFreshness(fresh, 100_000, { shownAt: 101_000, everyMs: 5_000 }).next).toBe(160_000);
  });

  it("says Live only while the map redraws within seconds", () => {
    const live = { last: 100_000, next: null, live: true };
    expect(mapBadgeFreshness(live, 100_000, { shownAt: 101_000, everyMs: 5_000 })).toMatchObject({
      live: true,
      next: null,
    });
    expect(mapBadgeFreshness(live, 100_000, { shownAt: 101_000, everyMs: 300_000 })).toMatchObject({
      live: false,
      next: 401_000,
    });
  });

  it("shows only the age once the coin is no longer scanned", () => {
    expect(mapBadgeFreshness({ last: 1, next: null }, 1, { shownAt: 2, everyMs: 5_000 }).next).toBeNull();
  });
});
