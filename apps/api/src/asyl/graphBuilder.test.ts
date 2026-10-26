import { describe, expect, it } from "vitest";
import { GraphBuilder } from "./graph.js";

const A = "So11111111111111111111111111111111111111112";
const B = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("GraphBuilder", () => {
  it("keeps a bought-together link's lead the right way round when it stores the ends in order", () => {
    const g = new GraphBuilder();
    // From A's search: B, the co-trader, bought 40s after A. B sorts first, so the line is stored
    // as B to A, and B to A is -40.
    g.edge({ a: A, b: B, kind: "cotrade", weight: 6, label: "", source: "stored", leadSec: 40, from: A });
    const [e] = g.graph().edges;
    expect(e!.a).toBe(B);
    expect(e!.b).toBe(A);
    expect(e!.leadSec).toBe(-40);
    expect(e!.from).toBe(A);
  });

  it("adds tags met later to a node it already has", () => {
    const g = new GraphBuilder();
    g.node(A, "wallet");
    g.node(A, "wallet", { tags: ["exchange"] });
    g.node(A, "wallet", { tags: ["dev"] });
    expect(g.get(A)!.tags.sort()).toEqual(["dev", "exchange"]);
  });
});
