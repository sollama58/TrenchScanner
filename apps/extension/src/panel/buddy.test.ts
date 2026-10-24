// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { token } from "../shared/testToken";
import type { BuddyCoin, OverlayBubbleMap } from "../shared/types";
import { bubbleMapView, countText, layoutBubbles, totalTiles } from "./bubble";
import { buddyCard, tradeUrl } from "./buddy";

const A = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

const map: OverlayBubbleMap = {
  mint: A,
  symbol: "RING",
  readAt: new Date(Date.now() - 40_000).toISOString(),
  scanAt: new Date().toISOString(),
  top50: false,
  holders: [
    { wallet: "w1", pct: 6, cluster: 0, sameTime: null, trait: "sniper", cex: false, creatorTied: false },
    { wallet: "w2", pct: 4, cluster: 0, sameTime: null, trait: null, cex: false, creatorTied: true },
    { wallet: "w3", pct: 2, cluster: null, sameTime: 0, trait: "fresh", cex: true, creatorTied: false },
    { wallet: "w4", pct: 0.3, cluster: null, sameTime: null, trait: null, cex: false, creatorTied: false },
  ],
  clusters: [{ funder: "f", pct: 10, count: 2, creatorLinked: false }],
  sameTime: [{ pct: 2, count: 1 }],
  totals: {
    linkedPct: 10,
    linkedCount: { count: 2, of: 25 },
    kolBundledPct: 0,
    bundledPct: 12,
    sameMinutePct: 2,
    sameMinuteCount: { count: 1, of: 25 },
    cexFundedPct: 5,
    cexFundedCount: { count: 1, of: 20 },
    devTiedPct: 4,
    transferredPct: null,
    transferredCount: null,
    top10Pct: 22,
    traits: [
      { trait: "sniper", count: 1, pct: 6 },
      { trait: "fresh", count: 1, pct: 2 },
    ],
  },
};

describe("the panel's bubble map", () => {
  it("lays bubbles out without overlap, inside the picture", () => {
    const placed = layoutBubbles(map.holders);
    expect(placed).toHaveLength(4);
    for (const a of placed)
      for (const b of placed)
        if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 0.01);
    for (const p of placed) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(0);
      expect(p.y + p.r).toBeLessThanOrEqual(210);
    }
  });

  it("shows the site's category totals, and a tile only where the scan read it", () => {
    expect(totalTiles(map).map((t) => `${t.label} ${t.value}`)).toEqual([
      "Linked 2/25 (10.0%)",
      "KOL bundled 0.0%",
      "Bundled 12.0%",
      "Same minute 1/25 (2.0%)",
      "CEX-funded 1/20 (5.0%)",
      "Tied to dev 4.0%",
      "Top 10 22.0%",
    ]);
    expect(countText(null, null)).toBe("–");
    const view = bubbleMapView(map);
    expect(view.querySelectorAll("circle").length).toBeGreaterThanOrEqual(4);
    expect(view.textContent).toContain("Sniper 1 · 6.0%");
    expect(view.querySelector("a")!.getAttribute("href")).toBe(`https://trenchscanner.app/?sage=${A}`);
    expect(bubbleMapView(null).textContent).toMatch(/No holder reading/);
  });
});

describe("Trade Buddy cards", () => {
  const coin: BuddyCoin = {
    mint: A,
    entryAt: new Date(Date.now() - 600_000).toISOString(),
    lastTradeAt: new Date(Date.now() - 600_000).toISOString(),
    buys: 1,
    sells: 0,
    spentSol: 0.5,
    gotSol: 0,
    held: 1_200_000,
    chainHeld: 1_200_000,
    closed: false,
    mismatch: false,
    entryMcapUsd: 10_000,
    nowMcapUsd: 15_000,
    pnlSol: 0.25,
    pnlPct: 50,
    priceAt: new Date().toISOString(),
    priceSource: "market",
    token: token(),
    symbol: "RING",
    name: "Ring Coin",
    image: null,
  };

  it("shows the PnL and the move since the buy, and the trade box only for Pro, collapsed", () => {
    const card = buddyCard(coin, DEFAULT_SETTINGS, false);
    expect(card.textContent).toContain("+0.250 SOL (+50%)");
    expect(card.textContent).toContain("Bought at $10.0K");
    expect(card.textContent).toContain("now $15.0K (+50%)");
    expect(card.textContent).toContain("Holding 1.2M");
    expect(card.querySelector("details.trade")).toBeNull();

    const pro = buddyCard(coin, DEFAULT_SETTINGS, true);
    const box = pro.querySelector("details.trade") as HTMLDetailsElement;
    expect(box.open).toBe(false);
    const hrefs = [...box.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`https://trenchscanner.app/?trade=${A}&buy=0.5`);
    expect(hrefs).toContain(`https://trenchscanner.app/?trade=${A}&sell=100`);
  });

  it("says when the wallet doesn't match its trades, and offers no sale of a sold-out coin", () => {
    const card = buddyCard({ ...coin, mismatch: true, pnlSol: null, pnlPct: null }, DEFAULT_SETTINGS, false);
    expect(card.textContent).toContain("Can't tell");
    const sold = buddyCard({ ...coin, closed: true, held: 0, chainHeld: 0 }, DEFAULT_SETTINGS, true);
    expect(sold.querySelector("a.preset.sell")).toBeNull();
    expect(tradeUrl("not-a-mint", "buy", 1)).toBeNull();
  });
});
