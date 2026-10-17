// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { OnChainProfile } from "@trenchscanner/core";
import { freshnessGroupsOf, withFreshTopHolders, withLinkedWallets } from "./scanJob.js";

describe("withLinkedWallets: exchange funders on the holder list", () => {
  const onChain = {
    topHolderShares: [
      { owner: "A", pct: 5 },
      { owner: "B", pct: 3 },
      { owner: "C", pct: 1 },
    ],
  } as unknown as OnChainProfile;
  const cex = {
    cexFundedPct: 66.7,
    cexFundedCount: 2,
    cexFundedHolders: 3,
    cexFunders: [
      { wallet: "A", funder: "EX1" },
      { wallet: "C", funder: "EX1" },
    ],
  };

  it("tags each exchange-funded holder with its funder, and leaves the input alone", () => {
    const out = withLinkedWallets(onChain, null, cex)!;
    expect(out.linkedHolders).toEqual([
      { wallet: "A", pct: 5, cexFunder: "EX1" },
      { wallet: "B", pct: 3 },
      { wallet: "C", pct: 1, cexFunder: "EX1" },
    ]);
    expect(out.cexFundedCount).toBe(2);
    expect((onChain as { linkedHolders?: unknown }).linkedHolders).toBeUndefined();
  });

  it("keeps the list untagged without an exchange reading", () => {
    expect(withLinkedWallets(onChain, null)!.linkedHolders).toEqual([
      { wallet: "A", pct: 5 },
      { wallet: "B", pct: 3 },
      { wallet: "C", pct: 1 },
    ]);
  });
});

describe("withLinkedWallets: launch snipers among the top holders", () => {
  const onChain = {
    topHolderShares: [
      { owner: "A", pct: 5 },
      { owner: "B", pct: 3 },
      { owner: "C", pct: 1 },
    ],
  } as unknown as OnChainProfile;
  const linked = {
    linkedWalletPct: 0,
    linkedClusterCount: 0,
    linkedWalletCount: 0,
    linkedWalletsChecked: 4,
    linkedLargestClusterPct: 0,
    linkedCreatorPct: 0,
    linkedCreatorDirectPct: 0,
    clusters: [],
    holders: [
      { wallet: "A", pct: 5 },
      { wallet: "B", pct: 3 },
      { wallet: "D", pct: 2 },
      { wallet: "C", pct: 1 },
    ],
    sameTimeFundedPct: 0,
    sameTimeClusterCount: 0,
    sameTimeFundedCount: 0,
    bundledWalletCount: 0,
    sameTimeClusters: [],
  };

  it("counts the first buyers on the linked reading's list (N of the holders read)", () => {
    const out = withLinkedWallets(onChain, linked, null, new Set(["B", "D", "Z"]))!;
    expect(out.sniperTopHolderCount).toBe(2);
    expect(out.sniperTopHoldersChecked).toBe(4);
  });

  it("falls back to the list the scan read, and stays unknown without the first buyers", () => {
    const out = withLinkedWallets(onChain, null, null, new Set(["A"]))!;
    expect(out.sniperTopHolderCount).toBe(1);
    expect(out.sniperTopHoldersChecked).toBe(3);
    expect(withLinkedWallets(onChain, linked)!.sniperTopHolderCount).toBeUndefined();
  });
});

describe("Fresh over the top 25 (freshnessGroupsOf, withFreshTopHolders)", () => {
  const top25 = (mint: string) => (mint === "M1" || mint === "M3" ? [`${mint}-a`, `${mint}-b`] : undefined);
  const groups = [
    { mintAddress: "M1", addresses: ["M1-a"] },
    { mintAddress: "M2", addresses: ["M2-a"] },
    { mintAddress: "M3", addresses: ["M3-a"] },
  ];

  it("puts the waited coins' top 10s first, then their top 25s, then the rest the same way", () => {
    expect(freshnessGroupsOf(groups, 2, top25)).toEqual({
      groups: [["M1-a"], ["M2-a"], ["M1-a", "M1-b"], ["M3-a"], ["M3-a", "M3-b"]],
      waited: 3,
    });
    expect(freshnessGroupsOf(groups, 0, () => undefined)).toEqual({
      groups: [["M1-a"], ["M2-a"], ["M3-a"]],
      waited: 0,
    });
  });

  it("counts fresh wallets over the list only once every wallet is resolved", () => {
    const now = Date.now();
    const onChain = { mintAddress: "M1" } as OnChainProfile;
    const earliest = new Map<string, Date | null>([
      ["a", new Date(now - 3_600_000)],
      ["b", new Date(now - 30 * 86_400_000)],
      ["c", null],
    ]);
    const out = withFreshTopHolders(onChain, ["a", "b", "c"], earliest)!;
    expect(out.freshTopHolderCount).toBe(1);
    expect(out.freshTopHoldersChecked).toBe(3);
    expect(withFreshTopHolders(onChain, ["a", "d"], earliest)!.freshTopHolderCount).toBeUndefined();
    expect(withFreshTopHolders(onChain, undefined, earliest)).toBe(onChain);
  });
});
