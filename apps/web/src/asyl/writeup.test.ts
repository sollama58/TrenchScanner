import { describe, expect, it } from "vitest";
import type { AsylEdge, AsylGraph, AsylNode } from "./graph";
import { diffGraphs, diffNote, graphJson, writeUp } from "./writeup";

const W = (id: string, o: Partial<AsylNode> = {}): AsylNode => ({
  id,
  kind: "wallet",
  name: null,
  tags: [],
  ...o,
});
const E = (a: string, b: string, kind: AsylEdge["kind"], o: Partial<AsylEdge> = {}): AsylEdge => ({
  a,
  b,
  kind,
  weight: 1,
  label: "",
  source: "stored",
  ...o,
});
const COIN = "Coin1111111111111111111111111111111111111111";
const g: AsylGraph = {
  nodes: [
    W("F".repeat(44), { name: "Farm" }),
    W("A".repeat(44), { name: "Ansem", tags: ["kol"] }),
    W("B".repeat(44), { tags: ["fresh"] }),
    { id: COIN, kind: "token", name: "$GRUG", tags: [], mcapUsd: 420_000, athUsd: 2_100_000 },
  ],
  edges: [
    E("F".repeat(44), "A".repeat(44), "funded", { sol: 12, at: "2026-10-02T00:00:00Z" }),
    E("F".repeat(44), "B".repeat(44), "funded", { sol: 3 }),
    E("B".repeat(44), COIN, "traded"),
  ],
};

describe("write-up", () => {
  it("names who is on the map, the coins, the money and the groups, with every address", () => {
    const md = writeUp(g, {
      title: "GRUG insiders",
      note: "One farm paid both.",
      notes: { ["B".repeat(44)]: "Bought 3s in" },
      now: new Date("2026-10-26T00:00:00Z"),
    });
    expect(md).toContain("# GRUG insiders");
    expect(md).toContain("Made with Asyl on 2026-10-26: 3 wallets, 1 coin, 3 links.");
    expect(md).toContain("- **KOL** (1): Ansem");
    expect(md).toContain("- **Fresh wallet** (1): BBBB…BBBB");
    expect(md).toContain("| [$GRUG](https://solscan.io/token/" + COIN + ") | $420K | $2.1M | 1 |");
    expect(md).toContain("- Farm → Ansem: 12.00 SOL (first funding, 2 Oct)");
    expect(md).toContain("- Farm funded 2: Ansem, BBBB…BBBB");
    expect(md).toContain("- **BBBB…BBBB**: Bought 3s in");
  });
  it("exports JSON with notes on their nodes", () => {
    const j = JSON.parse(graphJson(g, { title: "t", notes: { ["A".repeat(44)]: "big" } }));
    expect(j.nodes.find((n: AsylNode) => n.id === "A".repeat(44)).note).toBe("big");
    expect(j.edges).toHaveLength(3);
  });
});

describe("map diff", () => {
  it("says what is new and what is gone against a saved map", () => {
    const then: AsylGraph = {
      nodes: g.nodes.slice(0, 2).concat(W("C".repeat(44))),
      edges: g.edges.slice(0, 1),
    };
    const d = diffGraphs(g, then);
    expect(d.newNodes.map((n) => n.id)).toEqual(["B".repeat(44), COIN]);
    expect(d.goneNodes.map((n) => n.id)).toEqual(["C".repeat(44)]);
    expect(d.newEdges).toHaveLength(2);
    expect(diffNote(d, "Old")).toBe('Against "Old": 2 bubbles new, 1 bubble gone, 2 links new.');
    expect(diffNote(diffGraphs(g, g), "Old")).toBe('Same wallets, coins and links as "Old".');
  });
});
