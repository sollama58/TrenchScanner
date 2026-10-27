import { describe, expect, it } from "vitest";
import {
  timelineSteps,
  replaySpeeds,
  replayTick,
  addressIn,
  pickInBox,
  pickInLasso,
  NO_CUTOFFS,
  clearsCutoffs,
  cleanCutoffs,
  clusterOf,
  edgeKey,
  edgeTimeLabel,
  graphCsv,
  mergeGraph,
  removeNodes,
  visibleGraph,
  perWalletOf,
  withDeployLines,
  type AsylEdge,
  type AsylGraph,
  type AsylNode,
  NO_DRAWINGS,
  STROKE_POINTS_MAX,
  cleanDrawings,
  strokePath,
  thinStroke,
} from "./graph";
import { bounds, newLayout, placeNew, settle } from "./layout";

const W = (id: string, extra: object = {}) => ({
  id,
  kind: "wallet" as const,
  name: null,
  tags: [],
  ...extra,
});
const E = (a: string, b: string, kind: AsylGraph["edges"][number]["kind"], weight = 1) => ({
  a,
  b,
  kind,
  weight,
  label: `${a}-${b}`,
  source: "stored" as const,
});

describe("mergeGraph", () => {
  it("adds new nodes and keeps the first name unless the reader's label arrives", () => {
    const base: AsylGraph = { nodes: [W("a", { name: "Roster" })], edges: [] };
    const next: AsylGraph = { nodes: [W("a", { name: "Other" }), W("b")], edges: [E("a", "b", "funded")] };
    const merged = mergeGraph(base, next);
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(merged.nodes[0]!.name).toBe("Roster");
    const mine = mergeGraph(merged, { nodes: [W("a", { name: "Mine", tags: ["mine"] })], edges: [] });
    expect(mine.nodes[0]).toMatchObject({ name: "Mine", tags: ["mine"] });
  });

  it("keeps one edge per kind and pair, the stronger or the chain's", () => {
    const base: AsylGraph = { nodes: [W("a"), W("b")], edges: [E("a", "b", "transfer", 5)] };
    const weaker = mergeGraph(base, { nodes: [], edges: [E("a", "b", "transfer", 1)] });
    expect(weaker.edges).toHaveLength(1);
    expect(weaker.edges[0]!.weight).toBe(5);
    const chain = mergeGraph(base, {
      nodes: [],
      edges: [{ ...E("a", "b", "transfer", 1), source: "chain" }],
    });
    expect(chain.edges[0]!.source).toBe("chain");
  });
});

describe("removeNodes and visibleGraph", () => {
  const g: AsylGraph = {
    nodes: [W("a"), W("b"), W("c")],
    edges: [E("a", "b", "funded"), E("b", "c", "cotrade")],
  };
  it("drops hanging edges", () => {
    expect(removeNodes(g, new Set(["b"])).edges).toEqual([]);
  });
  it("keeps every bubble when a kind of link is switched off", () => {
    const v = visibleGraph(g, new Set(["cotrade"]), new Set());
    expect(v.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(v.edges.map((e) => e.kind)).toEqual(["funded"]);
  });
  it("hides the bubbles no link reaches only when asked, except the kept ones", () => {
    const loose = { hideLoose: true };
    expect(visibleGraph(g, new Set(["cotrade"]), new Set(["c"]), loose).nodes.map((n) => n.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(visibleGraph(g, new Set(["cotrade"]), new Set(), loose).nodes.map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });
  it("switches a kind off for one wallet only", () => {
    const perWallet = perWalletOf({ c: ["cotrade"], a: ["holds"] });
    const v = visibleGraph(g, new Set(), new Set(), { perWallet });
    expect(v.edges.map((e) => e.kind)).toEqual(["funded"]);
    expect(perWalletOf({ a: ["nope"] }).size).toBe(0);
  });
  it("switches one wallet's transfers off one way only", () => {
    const t: AsylGraph = {
      nodes: [W("a"), W("b")],
      edges: [E("a", "b", "transfer"), E("b", "a", "transfer")],
    };
    const sent = visibleGraph(t, new Set(), new Set(), { perWallet: perWalletOf({ a: ["transfer:out"] }) });
    expect(sent.edges.map((e) => e.a)).toEqual(["b"]);
    const got = visibleGraph(t, new Set(), new Set(), { perWallet: perWalletOf({ a: ["transfer:in"] }) });
    expect(got.edges.map((e) => e.a)).toEqual(["a"]);
  });
});

describe("link filters", () => {
  const g: AsylGraph = {
    nodes: [W("a"), W("b"), W("c"), W("m")],
    edges: [
      { ...E("a", "b", "funded", 0.5), sol: 0.5 },
      { ...E("b", "c", "transfer", 3), pct: 3 },
      { ...E("a", "m", "transfer", 2), mint: "m", tokens: 5_000 },
      E("c", "m", "holds", 9),
      E("a", "c", "cotrade", 2),
    ],
  };
  it("cuts money links under a slider, and never links that aren't money", () => {
    const c = { ...NO_CUTOFFS, sol: 1 };
    expect(clearsCutoffs(g.edges[0]!, c, null)).toBe(false);
    expect(clearsCutoffs(g.edges[3]!, { ...NO_CUTOFFS, pct: 50 }, null)).toBe(true);
    expect(clearsCutoffs(g.edges[4]!, c, null)).toBe(true);
    expect(clearsCutoffs(g.edges[1]!, { ...NO_CUTOFFS, pct: 5 }, null)).toBe(false);
    expect(clearsCutoffs(g.edges[2]!, { ...NO_CUTOFFS, tokens: 10_000 }, null)).toBe(false);
  });
  it("reads USD through SOL's price, and lets everything through without one", () => {
    const c = { ...NO_CUTOFFS, usd: 50 };
    expect(clearsCutoffs(g.edges[0]!, c, 200)).toBe(true);
    expect(clearsCutoffs(g.edges[0]!, c, 50)).toBe(false);
    expect(clearsCutoffs(g.edges[0]!, c, null)).toBe(true);
  });
  it("holds bought-together links to coins in common, seconds apart and who buys first", () => {
    const led = { ...E("a", "b", "cotrade", 7), shared: 7, of: 60, gapSec: 40, leadSec: -40 };
    const old = E("a", "c", "cotrade", 5);
    expect(clearsCutoffs(led, { ...NO_CUTOFFS, shared: 8 }, null)).toBe(false);
    expect(clearsCutoffs(led, { ...NO_CUTOFFS, shared: 7, gap: 45 }, null)).toBe(true);
    expect(clearsCutoffs(led, { ...NO_CUTOFFS, gap: 30 }, null)).toBe(false);
    expect(clearsCutoffs(led, { ...NO_CUTOFFS, first: 1 }, null)).toBe(true);
    expect(clearsCutoffs(led, { ...NO_CUTOFFS, first: 2 }, null)).toBe(false);
    // An older map's link: coins by its weight; no time or order to hold it to.
    expect(clearsCutoffs(old, { ...NO_CUTOFFS, shared: 6 }, null)).toBe(false);
    expect(clearsCutoffs(old, { ...NO_CUTOFFS, gap: 5, first: 2 }, null)).toBe(true);
    expect(cleanCutoffs({ sol: 1, first: 3, gap: -1 })).toEqual({ ...NO_CUTOFFS, sol: 1 });
  });
  it("reads an older map's funding by its weight", () => {
    expect(clearsCutoffs(E("a", "b", "funded", 0.2), { ...NO_CUTOFFS, sol: 1 }, null)).toBe(false);
  });
  it("drops links hidden one by one", () => {
    const v = visibleGraph(g, new Set(), new Set(), { cut: new Set([edgeKey(g.edges[4]!)]) });
    expect(v.edges.map((e) => e.kind)).not.toContain("cotrade");
    expect(v.edges).toHaveLength(4);
  });
});

describe("clusterOf", () => {
  it("groups wallets tied by funding, transfers or sides, never through an exchange", () => {
    const g: AsylGraph = {
      nodes: [W("a"), W("b"), W("c"), W("x", { tags: ["exchange"] }), W("d"), W("e")],
      edges: [
        E("a", "b", "funded"),
        E("b", "c", "transfer"),
        E("x", "d", "funded"),
        E("x", "e", "funded"),
        E("d", "e", "cotrade"),
      ],
    };
    const c = clusterOf(g);
    expect(c.get("a")).toBe(c.get("c"));
    expect(c.get("a")).toBe(0);
    expect(c.get("d")).toBe(-1);
    expect(c.get("x")).toBe(-1);
  });
});

describe("graphCsv", () => {
  it("quotes cells that need it", () => {
    const csv = graphCsv({ nodes: [W("a", { name: 'Big "A"' }), W("b")], edges: [E("a", "b", "funded")] });
    expect(csv.split("\n")[1]).toBe('a,"Big ""A""",b,,funded,a-b,1,,,stored');
  });
});

describe("addressIn", () => {
  it("finds an address in a link or bare", () => {
    const a = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(addressIn(` ${a} `)).toBe(a);
    expect(addressIn(`https://solscan.io/account/${a}?cluster=mainnet`)).toBe(a);
    expect(addressIn("not one")).toBeNull();
  });
});

describe("layout", () => {
  it("places new nodes near a placed neighbour and settles apart", () => {
    const state = newLayout();
    const g: AsylGraph = {
      nodes: [W("a"), W("b"), W("c")],
      edges: [E("a", "b", "funded"), E("a", "c", "funded")],
    };
    settle(state, g);
    const a = state.pos.get("a")!;
    const b = state.pos.get("b")!;
    const c = state.pos.get("c")!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
    expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThan(30);
    const box = bounds(state, ["a", "b", "c"]);
    expect(box.maxX - box.minX).toBeLessThan(800);
  });

  it("keeps pinned nodes where they were put and forgets removed ones", () => {
    const state = newLayout();
    const g: AsylGraph = { nodes: [W("a"), W("b")], edges: [E("a", "b", "funded")] };
    placeNew(state, g);
    state.pos.set("a", { x: 500, y: 500 });
    state.pinned.add("a");
    settle(state, g);
    expect(state.pos.get("a")).toEqual({ x: 500, y: 500 });
    placeNew(state, { nodes: [W("b")], edges: [] });
    expect(state.pos.has("a")).toBe(false);
  });
});

describe("withDeployLines", () => {
  const coin = { id: "c", kind: "token" as const, name: "$C", tags: [], deployer: "dev" };

  it("draws a Deployed line once the deployer is on the map, and marks it", () => {
    expect(withDeployLines({ nodes: [coin, W("x")], edges: [] }).edges).toEqual([]);
    const g = withDeployLines({ nodes: [coin, W("dev")], edges: [] });
    expect(g.edges).toEqual([expect.objectContaining({ a: "dev", b: "c", kind: "created" })]);
    expect(g.nodes.find((n) => n.id === "dev")?.tags).toEqual(["dev"]);
    // Never twice.
    expect(withDeployLines(g).edges).toHaveLength(1);
  });

  it("keeps a line the API already drew", () => {
    const g: AsylGraph = { nodes: [coin, W("dev", { tags: ["dev"] })], edges: [E("dev", "c", "created")] };
    expect(withDeployLines(g)).toBe(g);
  });

  it("drops a takeover wallet's line once the deployer is confirmed", () => {
    const g: AsylGraph = {
      nodes: [{ ...coin, deployerVerified: true }, W("dev"), W("cto")],
      edges: [E("cto", "c", "created")],
    };
    expect(withDeployLines(g).edges.map((e) => e.a)).toEqual(["dev"]);
  });

  it("keeps a confirmed deployer when an unconfirmed answer comes later", () => {
    const base: AsylGraph = { nodes: [{ ...coin, deployerVerified: true }], edges: [] };
    const merged = mergeGraph(base, {
      nodes: [{ ...coin, deployer: "cto", deployerVerified: false }],
      edges: [],
    });
    expect(merged.nodes[0]).toMatchObject({ deployer: "dev", deployerVerified: true });
  });
});

describe("edgeTimeLabel", () => {
  const now = new Date(2026, 9, 24, 18, 0);
  it("writes as much as the line has room for", () => {
    const iso = new Date(2026, 9, 12, 9, 5).toISOString();
    expect(edgeTimeLabel(iso, 40, now)).toBe("12 Oct 09:05");
    expect(edgeTimeLabel(iso, 8, now)).toBe("12 Oct");
    expect(edgeTimeLabel(iso, 4, now)).toBeNull();
  });
  it("shows the year only for another year, and just the time for today", () => {
    expect(edgeTimeLabel(new Date(2025, 0, 3, 14, 30).toISOString(), 40, now)).toBe("3 Jan 2025 14:30");
    expect(edgeTimeLabel(new Date(2026, 9, 24, 14, 30).toISOString(), 6, now)).toBe("14:30");
  });
  it("is null without a time", () => {
    expect(edgeTimeLabel(null, 40, now)).toBeNull();
  });
});

describe("pen strokes", () => {
  it("draws a smooth path, and a dot for one point", () => {
    expect(strokePath([[0, 0]])).toBe("M0 0 l0.01 0");
    expect(
      strokePath([
        [0, 0],
        [10, 0],
        [20, 10],
      ]),
    ).toBe("M0 0 Q10 0 15 5 L20 10");
  });
  it("thins a long stroke to what a map keeps, keeping its ends", () => {
    const pts: [number, number][] = Array.from({ length: 2000 }, (_, i) => [i, Math.sin(i / 50) * 40]);
    const kept = thinStroke(pts);
    expect(kept.length).toBeLessThanOrEqual(STROKE_POINTS_MAX);
    expect(kept[0]).toEqual(pts[0]);
    expect(kept[kept.length - 1]).toEqual(pts[pts.length - 1]);
  });
  it("reads drawings saved before the pen", () => {
    expect(cleanDrawings({ lines: [], texts: [] })).toEqual({ lines: [], texts: [], strokes: [] });
    expect(cleanDrawings(undefined)).toEqual(NO_DRAWINGS);
  });
});

describe("picking bubbles", () => {
  const pos = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 50, y: 50 }],
    ["c", { x: 200, y: 10 }],
  ]);
  it("takes those inside a box dragged either way", () => {
    expect(pickInBox(pos, pos.keys(), { x: 60, y: 60 }, { x: -10, y: -10 })).toEqual(["a", "b"]);
    expect(pickInBox(pos, ["a", "c"], { x: -10, y: -10 }, { x: 300, y: 300 })).toEqual(["a", "c"]);
  });
  it("takes those inside a lasso, and none for a loop too short to close", () => {
    // A triangle around a and b, leaving c out.
    const loop: [number, number][] = [
      [-20, -20],
      [160, -20],
      [-20, 160],
    ];
    expect(pickInLasso(pos, pos.keys(), loop)).toEqual(["a", "b"]);
    expect(
      pickInLasso(pos, pos.keys(), [
        [0, 0],
        [10, 10],
      ]),
    ).toEqual([]);
  });
});

describe("who buys first, on a bought-together line stored either way round", () => {
  const first = (c: 1 | 2) => ({ ...NO_CUTOFFS, first: c });
  it("reads the co-trader from the line's own `from`", () => {
    // Searched from b; a is the co-trader and bought 30s before b: leadSec (a to b) is +30.
    const e = {
      a: "a",
      b: "b",
      kind: "cotrade" as const,
      weight: 5,
      label: "",
      source: "stored" as const,
      shared: 5,
      leadSec: 30,
      from: "b",
    };
    expect(clearsCutoffs(e, first(1), null)).toBe(true);
    expect(clearsCutoffs(e, first(2), null)).toBe(false);
    // Saved before lines carried `from`: the far end is taken as the co-trader.
    const old = { ...e, from: undefined };
    expect(clearsCutoffs(old, first(1), null)).toBe(false);
    expect(clearsCutoffs(old, first(2), null)).toBe(true);
  });
});

describe("the timeline", () => {
  const n = (id: string): AsylNode => ({ id, kind: "wallet", name: null, tags: [] });
  const e = (a: string, b: string, at?: string): AsylEdge => ({
    a,
    b,
    kind: "funded",
    weight: 1,
    label: "",
    source: "stored",
    at: at ?? null,
  });
  const g: AsylGraph = {
    nodes: [n("a"), n("b"), n("c"), n("d"), n("x")],
    edges: [e("a", "b", "2026-10-01T00:00:00Z"), e("b", "c", "2026-10-03T00:00:00Z"), e("a", "d")],
  };
  it("steps through each link's date, and draws only what happened by then", () => {
    const steps = timelineSteps(g);
    expect(steps).toEqual([Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-03T00:00:00Z")]);
    const v = visibleGraph(g, new Set(), new Set(["x"]), { until: steps[0] });
    // Undated links stay; a wallet whose first link is later isn't there yet; the focus stays.
    expect(v.edges.map((x) => `${x.a}>${x.b}`)).toEqual(["a>b", "a>d"]);
    expect(v.nodes.map((x) => x.id).sort()).toEqual(["a", "b", "d", "x"]);
    expect(visibleGraph(g, new Set(), new Set(), { until: null }).nodes).toHaveLength(5);
  });
});

describe("replay speed", () => {
  it("offers speeds that keep the whole replay between a few seconds and a few minutes", () => {
    expect(replayTick(1)).toEqual({ ms: 140, stride: 1 });
    expect(replayTick(4)).toEqual({ ms: 35, stride: 1 });
    // Past that it redraws no faster, moving on several moments a tick.
    expect(replayTick(16)).toEqual({ ms: 35, stride: 4 });
    // A handful of moments: nothing faster than 1×, so it isn't over in a blink.
    expect(replaySpeeds(10)).toEqual([0.25, 0.5, 1]);
    expect(replaySpeeds(100)).toEqual([0.25, 0.5, 1, 2, 4]);
    // Thousands of moments: nothing slower than 1×, so it ends this side of a few minutes.
    expect(replaySpeeds(2000)).toEqual([1, 2, 4, 8, 16]);
    expect(replaySpeeds(0)).toEqual([0.25, 0.5, 1]);
  });
});
