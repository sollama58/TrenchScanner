import { describe, expect, it } from "vitest";
import {
  addressIn,
  clusterOf,
  graphCsv,
  mergeGraph,
  removeNodes,
  visibleGraph,
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
