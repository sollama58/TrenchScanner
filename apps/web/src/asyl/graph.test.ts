import { describe, expect, it } from "vitest";
import {
  addressIn,
  NO_CUTOFFS,
  clearsCutoffs,
  clusterOf,
  edgeKey,
  graphCsv,
  mergeGraph,
  removeNodes,
  visibleGraph,
  withDeployLines,
  type AsylGraph,
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
  it("hides nodes only hidden kinds tied, except the kept ones", () => {
    const v = visibleGraph(g, new Set(["cotrade"]), new Set(["c"]));
    expect(v.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(visibleGraph(g, new Set(["cotrade"]), new Set()).nodes.map((n) => n.id)).toEqual(["a", "b"]);
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
