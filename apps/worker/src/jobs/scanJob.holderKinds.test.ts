// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { OnChainProfile } from "@trenchscanner/core";
import { withHolderKinds } from "./scanJob.js";
import type { WalletHoldings } from "./walletHoldings.js";

describe("withHolderKinds (user ask 2026-10-15)", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const onChain = {
    mintAddress: "MINT",
    linkedHolders: [
      { wallet: "A", pct: 5 },
      { wallet: "B", pct: 3, cexFunder: "EX" },
      { wallet: "C", pct: 1 },
      { wallet: "D", pct: 0.5 },
    ],
  } as unknown as OnChainProfile;
  const earliest = new Map<string, Date | null>([
    ["A", new Date(now - 2 * 3_600_000)],
    ["B", new Date(now - 30 * 24 * 3_600_000)],
    ["C", null],
  ]);
  const holdings = new Map<string, WalletHoldings>([
    ["B", { otherHoldingsUsd: 400, perMintUsd: { MINT: 390 } }],
    ["C", { otherHoldingsUsd: 5000, perMintUsd: { MINT: 100 } }],
    ["D", { otherHoldingsUsd: 10, perMintUsd: {} }],
  ]);

  it("marks the snipers, the fresh wallets and the empty ones, and leaves unread wallets alone", () => {
    const out = withHolderKinds(
      onChain,
      earliest,
      holdings,
      { WALLET_HOLDINGS_MIN_USD: 25 },
      new Set(["C"]),
      now,
    )!;
    expect(out.linkedHolders).toEqual([
      { wallet: "A", pct: 5, fresh: true },
      { wallet: "B", pct: 3, cexFunder: "EX", empty: true },
      { wallet: "C", pct: 1, sniper: true },
      { wallet: "D", pct: 0.5 },
    ]);
  });

  it("passes a profile without a holder list through", () => {
    const bare = { mintAddress: "MINT" } as unknown as OnChainProfile;
    expect(withHolderKinds(bare, earliest, holdings, { WALLET_HOLDINGS_MIN_USD: 25 })).toBe(bare);
  });
});
