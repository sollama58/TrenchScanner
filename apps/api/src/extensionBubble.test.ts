import { describe, expect, it } from "vitest";
import { overlayBubbleMap, pickBubbleScan, type BubbleScan } from "./extensionBubble.js";
import { buddyAnswer, BUDDY_CLOSED_MS } from "./extensionBuddy.js";
import type { TradeCoin } from "./routes/proTrades.js";

const base: BubbleScan = {
  takenAt: new Date("2026-10-24T12:00:00Z"),
  linkedHolders: null,
  linkedClusters: null,
  sameTimeClusters: null,
  linkedWalletPct: null,
  linkedWalletCount: null,
  linkedWalletsChecked: null,
  kolBundledPct: null,
  bundledSupplyPct: null,
  sameTimeFundedPct: null,
  sameTimeFundedCount: null,
  cexFundedPct: null,
  cexFundedCount: null,
  cexFundedHolders: null,
  linkedCreatorPct: null,
  transferredSupplyPct: null,
  transferWalletCount: null,
  transferHoldersChecked: null,
  top10HolderPct: null,
};

const scan: BubbleScan = {
  ...base,
  linkedHolders: [
    { wallet: "a", pct: 6, sniper: true },
    { wallet: "b", pct: 4, fresh: true, creatorTied: true },
    { wallet: "c", pct: 3, cexFunder: "ex" },
    { wallet: "d", pct: 1, blockZero: true, sniper: true },
  ],
  linkedClusters: [
    {
      funder: "f",
      wallets: [
        { wallet: "a", pct: 6 },
        { wallet: "b", pct: 4 },
      ],
      pct: 10,
    },
  ],
  sameTimeClusters: [
    {
      wallets: [
        { wallet: "c", pct: 3 },
        { wallet: "d", pct: 1 },
      ],
      pct: 4,
    },
  ],
  linkedWalletPct: 10,
  linkedWalletCount: 2,
  linkedWalletsChecked: 25,
  kolBundledPct: 1.5,
  bundledSupplyPct: 14,
  sameTimeFundedPct: 4,
  sameTimeFundedCount: 2,
  cexFundedPct: 3,
  cexFundedCount: 1,
  cexFundedHolders: 20,
  linkedCreatorPct: 4,
  transferredSupplyPct: 0,
  transferWalletCount: 0,
  transferHoldersChecked: 25,
  top10HolderPct: 22,
};

describe("the extension's bubble map", () => {
  it("draws the scan's holders with their clusters, groups and types, and the scan's totals", () => {
    const map = overlayBubbleMap("m", "SYM", scan, { takenAt: scan.takenAt }, null);
    expect(map.top50).toBe(false);
    expect(map.holders.map((h) => [h.wallet, h.cluster, h.sameTime, h.trait])).toEqual([
      ["a", 0, null, "sniper"],
      ["b", 0, null, "fresh"],
      ["c", null, 0, null],
      ["d", null, 0, "blockZero"],
    ]);
    expect(map.holders.find((h) => h.wallet === "c")!.cex).toBe(true);
    expect(map.holders.find((h) => h.wallet === "b")!.creatorTied).toBe(true);
    expect(map.clusters).toEqual([{ funder: "f", pct: 10, count: 2, creatorLinked: false }]);
    expect(map.totals).toMatchObject({
      linkedPct: 10,
      linkedCount: { count: 2, of: 25 },
      kolBundledPct: 1.5,
      bundledPct: 14,
      sameMinuteCount: { count: 2, of: 25 },
      cexFundedCount: { count: 1, of: 20 },
      devTiedPct: 4,
      transferredPct: 0,
      top10Pct: 22,
    });
    expect(map.totals.traits).toEqual([
      { trait: "blockZero", count: 1, pct: 1 },
      { trait: "sniper", count: 1, pct: 6 },
      { trait: "fresh", count: 1, pct: 4 },
    ]);
  });

  it("draws the top 50 while it is current, with the scan's types, and keeps the scan's totals", () => {
    const wide = {
      readAt: new Date(scan.takenAt.getTime() - 60_000),
      holders: [
        { wallet: "a", pct: 5.5 },
        { wallet: "z", pct: 0.4, rank: 40 },
      ],
      clusters: [
        {
          funder: "g",
          wallets: [
            { wallet: "a", pct: 5.5 },
            { wallet: "z", pct: 0.4 },
          ],
          pct: 5.9,
        },
      ],
      sameTimeClusters: [],
    };
    const map = overlayBubbleMap("m", null, scan, { takenAt: scan.takenAt }, wide);
    expect(map.top50).toBe(true);
    expect(map.holders.map((h) => [h.wallet, h.cluster, h.trait])).toEqual([
      ["a", 0, "sniper"],
      ["z", 0, null],
    ]);
    expect(map.totals.linkedPct).toBe(10);
    // Older than the scan's list by more than the stale window: the scan's own picture.
    const stale = { ...wide, readAt: new Date(scan.takenAt.getTime() - 13 * 60_000) };
    expect(overlayBubbleMap("m", null, scan, null, stale).top50).toBe(false);
  });

  it("picks the newest scan with a checked list, as the site does", () => {
    const listOnly = { ...scan, linkedWalletPct: null };
    expect(pickBubbleScan([base, listOnly, scan])).toBe(scan);
    expect(pickBubbleScan([base, listOnly])).toBe(listOnly);
    expect(pickBubbleScan([base])).toBeNull();
    const empty = overlayBubbleMap("m", null, null, null, null);
    expect(empty.holders).toEqual([]);
    expect(empty.totals.linkedPct).toBeNull();
  });
});

describe("Trade Buddy", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const coin = (mint: string, closed: boolean, lastAgoMs: number): TradeCoin =>
    ({
      mint,
      symbol: mint.toUpperCase(),
      name: null,
      imageUrl: null,
      entryAt: new Date(now - lastAgoMs - 60_000),
      lastTradeAt: new Date(now - lastAgoMs),
      buys: 1,
      sells: closed ? 1 : 0,
      spentSol: 1,
      gotSol: closed ? 2 : 0,
      held: closed ? 0 : 1000,
      closed,
      entryMcapUsd: 10_000,
      pnlSol: 0.5,
      pnlPct: 50,
      priceAt: new Date(now),
      priceSource: closed ? null : "market",
      chainHeld: closed ? 0 : 1000,
      mismatch: false,
      calledBefore: null,
      card: closed ? null : ({ currentMarketCapUsd: 15_000 } as TradeCoin["card"]),
      scan: "scanned",
    }) as TradeCoin;

  it("lists held coins and those sold out within a day, with their PnL", () => {
    const answer = buddyAnswer(
      {
        coins: [
          coin("held", false, 60_000),
          coin("sold", true, 3_600_000),
          coin("old", true, BUDDY_CLOSED_MS + 1),
        ],
        solUsd: 180,
        readAt: new Date(now),
        chainAt: null,
      },
      [],
      true,
      now,
    );
    expect(answer.coins.map((c) => c.mint)).toEqual(["held", "sold"]);
    expect(answer.coins[0]).toMatchObject({ nowMcapUsd: 15_000, pnlSol: 0.5, pnlPct: 50, token: null });
    expect(answer.pro).toBe(true);
  });
});
