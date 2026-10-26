import { describe, expect, it } from "vitest";
import { analystLayout, analystView, boxesOf, familiesOf, linkText, money, routesOf } from "./analyst";
import type { AsylEdge, AsylGraph, AsylNode } from "./graph";

const W = (id: string, o: Partial<AsylNode> = {}): AsylNode => ({
  id,
  kind: "wallet",
  name: null,
  tags: [],
  ...o,
});
const T = (id: string, name: string): AsylNode => ({ id, kind: "token", name, tags: [] });
const E = (a: string, b: string, kind: AsylEdge["kind"], o: Partial<AsylEdge> = {}): AsylEdge => ({
  a,
  b,
  kind,
  weight: 1,
  label: "",
  source: "stored",
  ...o,
});

describe("Analyst Mode", () => {
  it("folds wallets that only traded or hold one coin into that coin's box", () => {
    const g: AsylGraph = {
      nodes: [
        T("coin", "$GRUG"),
        W("h1"),
        W("h2"),
        W("h3"),
        W("busy"),
        W("named", { name: "Ansem" }),
        W("fund"),
      ],
      edges: [
        E("h1", "coin", "holds"),
        E("h2", "coin", "holds"),
        E("h3", "coin", "traded"),
        E("busy", "coin", "holds"),
        E("fund", "busy", "funded"),
        E("named", "coin", "holds"),
      ],
    };
    const v = analystView(g, null);
    expect(v.groups.get("coin")?.sort()).toEqual(["h1", "h2", "h3"]);
    expect(v.groupVerb.get("coin")).toBe("traded or hold");
    // A wallet with other links, or a name, stays its own box.
    expect(v.graph.nodes.map((n) => n.id).sort()).toEqual(["busy", "coin", "fund", "named"]);
    expect(v.graph.edges.some((e) => e.a === "h1")).toBe(false);
    const box = boxesOf(v, null).get("coin")!;
    expect(box.role).toBe("group");
    expect(box.lines).toEqual(["3 addresses", "that traded or hold", "$GRUG"]);
    // The focus never folds.
    expect(analystView(g, "h1").memberOf.has("h1")).toBe(false);
  });

  it("lays money out top to bottom, deployers over their coins, rows without overlaps", () => {
    const g: AsylGraph = {
      nodes: [
        W("cex", { tags: ["exchange"], name: "Binance" }),
        W("funder"),
        W("a"),
        W("b"),
        W("dev"),
        T("coin", "$X"),
        W("buyer"),
      ],
      edges: [
        E("cex", "funder", "funded", { sol: 40 }),
        E("funder", "a", "funded", { sol: 2 }),
        E("funder", "b", "funded", { sol: 2 }),
        E("a", "funder", "transfer", { sol: 1 }),
        E("dev", "coin", "created"),
        E("funder", "dev", "funded", { sol: 1 }),
        E("buyer", "coin", "traded", { sol: 3 }),
      ],
    };
    const v = analystView(g, null);
    const boxes = boxesOf(v, null);
    expect(boxes.get("dev")!.role).toBe("dev");
    expect(boxes.get("dev")!.caption).toBe("$X dev");
    expect(boxes.get("cex")!.role).toBe("service");
    const pos = analystLayout(v.graph, boxes);
    const y = (id: string) => pos.get(id)!.y;
    expect(y("cex")).toBeLessThan(y("funder"));
    expect(y("funder")).toBeLessThan(y("a"));
    expect(y("a")).toBe(y("b"));
    expect(y("dev")).toBeLessThan(y("coin"));
    expect(y("buyer")).toBeLessThan(y("coin"));
    // No two boxes in a row overlap.
    const ids = [...pos.keys()];
    for (const p of ids)
      for (const q of ids) {
        if (p >= q || y(p) !== y(q)) continue;
        const gap = Math.abs(pos.get(p)!.x - pos.get(q)!.x) - (boxes.get(p)!.w + boxes.get(q)!.w) / 2;
        expect(gap).toBeGreaterThan(0);
      }
    // Boxes the reader dragged stay put.
    const held = analystLayout(v.graph, boxes, new Map([["a", { x: 999, y: -5 }]]));
    expect(held.get("a")).toEqual({ x: 999, y: -5 });
  });

  it("routes lines at right angles from box edge to box edge, with the money on them", () => {
    const g: AsylGraph = {
      nodes: [W("top"), W("left"), W("right")],
      edges: [
        E("top", "left", "funded", { sol: 2 }),
        E("top", "right", "funded", { sol: 5 }),
        E("left", "right", "cotrade", { shared: 4 }),
      ],
    };
    const v = analystView(g, null);
    const boxes = boxesOf(v, null);
    const pos = analystLayout(v.graph, boxes);
    const routes = routesOf(v.graph, boxes, pos, 150);
    expect(routes).toHaveLength(3);
    for (const r of routes)
      for (let i = 1; i < r.points.length; i++) {
        const [x1, y1] = r.points[i - 1]!;
        const [x2, y2] = r.points[i]!;
        expect(x1 === x2 || y1 === y2).toBe(true);
      }
    const down = routes.find((r) => r.edge.b === "left")!;
    expect(down.points[0]![1]).toBe(pos.get("top")!.y + boxes.get("top")!.h / 2);
    expect(down.points[down.points.length - 1]![1]).toBe(pos.get("left")!.y - boxes.get("left")!.h / 2);
    expect(down.text).toBe("$300");
    expect(routes.find((r) => r.edge.kind === "cotrade")!.text).toBe("4 coins");
  });

  it("writes money short, in dollars when SOL's price is known", () => {
    expect(money(2, 150)).toBe("$300");
    expect(money(100, 130)).toBe("$13k");
    expect(money(12, 150)).toBe("$1.8k");
    expect(money(10000, 200)).toBe("$2M");
    expect(money(1.5, null)).toBe("1.5 SOL");
    expect(money(42.25, null)).toBe("42.3 SOL");
    expect(linkText(E("a", "b", "holds", { pct: 2.5 }), null)).toBe("2.5%");
    expect(linkText(E("a", "b", "funded", { sol: null, weight: 0 }), null)).toBe("funded");
  });

  it("finds families of side wallets", () => {
    const g: AsylGraph = {
      nodes: [W("a"), W("b"), W("c"), W("d")],
      edges: [E("a", "b", "side"), E("b", "c", "side")],
    };
    const f = [...familiesOf(g).values()];
    expect(f).toHaveLength(1);
    expect(f[0]!.sort()).toEqual(["a", "b", "c"]);
  });
});
