// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { OnChainProfile } from "@trenchscanner/core";
import { withLinkedWallets } from "./scanJob.js";

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
