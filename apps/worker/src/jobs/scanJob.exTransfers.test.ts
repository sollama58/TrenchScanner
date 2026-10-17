// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { LinkedWalletsReading, OnChainProfile } from "@trenchscanner/core";
import type { KolBundledReading } from "./kolBundled.js";
import { exTransfersOf, withExTransfers } from "./scanJob.js";

const reading = (pct: number, count: number, wallets: string[][]) =>
  ({
    linkedWalletPct: pct,
    linkedWalletCount: count,
    linkedCreatorPct: count + 1,
    linkedCreatorDirectPct: count,
    clusters: wallets.map((w) => ({
      funder: w[0],
      wallets: w.map((x) => ({ wallet: x, pct: 1 })),
      pct: w.length,
      creatorLinked: false,
    })),
  }) as unknown as LinkedWalletsReading;
const bundled = (pct: number) =>
  ({ kolBundledPct: pct, bundledSupplyPct: pct + 1, bundledSupplyCount: 2 }) as unknown as KolBundledReading;

describe("figures without transfers", () => {
  const base = reading(10, 2, [["a", "b"]]);
  const counted = reading(15, 3, [["a", "b", "c"]]);

  it("keeps the funding-only figures when transfers changed the clusters", () => {
    const ex = exTransfersOf(base, counted, bundled(20), bundled(12))!;
    expect(ex).toMatchObject({ linkedWalletPct: 10, linkedWalletCount: 2, clusters: base.clusters });
    expect(ex.kolBundled!.kolBundledPct).toBe(12);
    const onChain = withExTransfers({ linkedWalletPct: 15 } as OnChainProfile, ex)!;
    expect(onChain).toMatchObject({
      linkedWalletPct: 15,
      linkedWalletPctExTransfers: 10,
      linkedWalletCountExTransfers: 2,
      linkedCreatorPctExTransfers: 2,
      kolBundledPctExTransfers: 12,
      bundledSupplyPctExTransfers: 13,
      bundledSupplyCountExTransfers: 2,
      linkedClustersExTransfers: base.clusters,
    });
  });

  it("records the same figures, without clusters, when transfers changed nothing", () => {
    const ex = exTransfersOf(base, base, bundled(20), undefined)!;
    expect(ex.clusters).toBeUndefined();
    expect(ex.kolBundled!.kolBundledPct).toBe(20);
    const onChain = withExTransfers({ linkedWalletPct: 10 } as OnChainProfile, ex)!;
    expect(onChain.linkedWalletPctExTransfers).toBe(10);
    expect(onChain.linkedClustersExTransfers).toBeUndefined();
  });

  it("records nothing without a funding reading", () => {
    expect(exTransfersOf(null, counted, undefined, undefined)).toBeNull();
    const onChain = { linkedWalletPct: 15 } as OnChainProfile;
    expect(withExTransfers(onChain, null)).toBe(onChain);
  });
});
