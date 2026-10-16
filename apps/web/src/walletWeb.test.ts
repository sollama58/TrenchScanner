import { describe, expect, it } from "vitest";
import { layoutWeb, tieText, webRadius, type WebNode } from "./walletWeb";

const node = (wallet: string, role: WebNode["role"], pct = 0): WebNode => ({
  wallet,
  role,
  name: null,
  pct,
  hours: 48,
});

describe("layoutWeb", () => {
  it("puts the hub in the middle and keeps every bubble apart", () => {
    const nodes = [
      node("hub", "hub"),
      node("alt", "known"),
      node("paid", "funded"),
      ...Array.from({ length: 40 }, (_, i) => node(`p${i}`, "possible", 100 - i)),
    ];
    const edges = nodes
      .slice(1)
      .map((n) => ({ from: "hub", to: n.wallet, type: "trades" as const, pct: n.pct }));
    const { nodes: placed, edges: drawn, box } = layoutWeb({ hub: "hub", nodes, edges });
    expect(placed[0]).toMatchObject({ x: 0, y: 0, r: webRadius({ role: "hub", pct: 0 }) });
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!;
        const b = placed[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
    expect(drawn).toHaveLength(edges.length);
    for (const n of placed) {
      expect(n.x - n.r).toBeGreaterThanOrEqual(box.x);
      expect(n.x + n.r).toBeLessThanOrEqual(box.x + box.w);
    }
  });

  it("fans out two ties between the same pair and places a shared funder outside its wallets", () => {
    const nodes = [
      node("hub", "hub"),
      node("a", "possible", 90),
      node("b", "possible", 0),
      node("f", "funder"),
    ];
    const { nodes: placed, edges } = layoutWeb({
      hub: "hub",
      nodes,
      edges: [
        { from: "hub", to: "a", type: "trades", pct: 90 },
        { from: "a", to: "hub", type: "transfers", count: 3 },
        { from: "f", to: "a", type: "funded" },
        { from: "f", to: "b", type: "funded" },
      ],
    });
    expect(edges[0]!.d).not.toBe(edges[1]!.d);
    const f = placed.find((n) => n.wallet === "f")!;
    const a = placed.find((n) => n.wallet === "a")!;
    expect(Math.hypot(f.x, f.y)).toBeGreaterThan(Math.hypot(a.x, a.y));
    expect(placed.find((n) => n.wallet === "b")!.moverOnly).toBe(true);
  });
});

describe("tieText", () => {
  it("reads each tie from the picked wallet's side, round the other's name", () => {
    expect(tieText({ from: "kol", to: "w", type: "funded", sol: 1.5 }, "w")).toEqual([
      "First SOL paid by ",
      " · 1.50 SOL",
    ]);
    expect(tieText({ from: "kol", to: "w", type: "funded", sol: 12 }, "kol")).toEqual([
      "Paid the first SOL of ",
      " · 12 SOL",
    ]);
    expect(tieText({ from: "kol", to: "w", type: "trades", pct: 95.6, hours: 48 }, "w")).toEqual([
      "Bought 96% of the same coins as ",
      " within minutes, over 48h",
    ]);
    expect(tieText({ from: "a", to: "b", type: "transfers", count: 1 }, "a")).toEqual([
      "1 coin transfer with ",
      "",
    ]);
  });
});
