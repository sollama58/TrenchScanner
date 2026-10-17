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

describe("layoutWeb ties", () => {
  it("runs a pair's ties as side-by-side lanes from the rims, not stacked at the centres", () => {
    const nodes = [node("hub", "hub"), node("k", "known")];
    const { nodes: placed, edges } = layoutWeb({
      hub: "hub",
      nodes,
      edges: [
        { from: "hub", to: "k", type: "known" },
        { from: "hub", to: "k", type: "funded", sol: 1 },
        { from: "k", to: "hub", type: "transfers", count: 4 },
      ],
    });
    const mids = edges.map((e) => e.mid);
    for (let i = 0; i < mids.length; i++)
      for (let j = i + 1; j < mids.length; j++)
        expect(Math.hypot(mids[i]!.x - mids[j]!.x, mids[i]!.y - mids[j]!.y)).toBeGreaterThan(3);
    const hub = placed.find((n) => n.wallet === "hub")!;
    for (const e of edges) {
      const [x, y] = e.d.slice(1).split(" ").map(Number) as [number, number];
      expect(Math.hypot(x - hub.x, y - hub.y) > hub.r - 2 || e.from !== "hub").toBe(true);
    }
  });

  it("sets two Known Sides side by side, not one behind the other, and keeps names clear", () => {
    const nodes = [node("hub", "hub"), node("k1", "known"), node("k2", "known"), node("f1", "funded")];
    const { nodes: placed } = layoutWeb({
      hub: "hub",
      nodes,
      edges: nodes.slice(1).map((n) => ({
        from: "hub",
        to: n.wallet,
        type: n.role === "known" ? ("known" as const) : ("funded" as const),
      })),
    });
    const k1 = placed.find((n) => n.wallet === "k1")!;
    const k2 = placed.find((n) => n.wallet === "k2")!;
    // Their angles round the hub differ by more than either bubble subtends: neither hides the other's tie.
    const angle = (n: { x: number; y: number }) => Math.atan2(n.y, n.x);
    let gap = Math.abs(angle(k1) - angle(k2));
    if (gap > Math.PI) gap = 2 * Math.PI - gap;
    expect(gap).toBeGreaterThan(Math.asin(k1.r / Math.hypot(k1.x, k1.y)) * 2);
    // No bubble sits on another's name (40 either side, just under it).
    for (const a of placed)
      for (const b of placed) {
        if (a === b) continue;
        const y = a.y + a.r + (a.role === "hub" ? 18 : 11);
        const nx = Math.max(a.x - 40, Math.min(b.x, a.x + 40));
        const ny = Math.max(y - 6, Math.min(b.y, y + 6));
        expect(Math.hypot(b.x - nx, b.y - ny)).toBeGreaterThan(b.r);
      }
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
