import { beforeEach, describe, expect, it } from "vitest";
import { withWalletSignals } from "./scanSignals.js";
import { heldEmptyReject, noteEmptyReading, resetAlertWallets } from "./walletPriority.js";
import type { WalletHoldings } from "./walletHoldings.js";

const MINT = "HoldMint111111111111111111111111111111111111";
const top10 = Array.from({ length: 10 }, (_, i) => `holder-${i}`);
const profile = {
  mintAddress: MINT,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  lpBurned: true,
  top10HolderAddresses: top10,
};
const env = { WALLET_HOLDINGS_MIN_USD: 25 };
const holdings = (emptyCount: number) =>
  new Map<string, WalletHoldings>(
    top10.map((a, i) => [a, { otherHoldingsUsd: i < emptyCount ? 1 : 500, perMintUsd: { [MINT]: 0 } }]),
  );

describe("an Empty reject held while the coin has no reading (Helius cuts impact audit 2026-11-27)", () => {
  beforeEach(() => resetAlertWallets());

  it("keeps a reject on the screen's cut when the next reading is unknown, as an atLeast bound", () => {
    const first = withWalletSignals(profile, new Map(), holdings(9), env);
    expect(first?.emptyTop10WalletPct).toBe(90);
    // The holders' readings expired unread: no share, but the reject stands.
    const later = withWalletSignals(profile, new Map(), new Map(), env);
    expect(later?.emptyTop10WalletPct).toBe(90);
    expect(later?.emptyTop10WalletBound).toBe("atLeast");
  });

  it("lets a new reading under the cut clear the hold", () => {
    withWalletSignals(profile, new Map(), holdings(9), env);
    expect(withWalletSignals(profile, new Map(), holdings(2), env)?.emptyTop10WalletPct).toBe(20);
    expect(withWalletSignals(profile, new Map(), new Map(), env)?.emptyTop10WalletPct).toBeUndefined();
  });

  it("holds nothing for a reading under the cut, and lets a hold run out after an hour", () => {
    noteEmptyReading(MINT, 70, 0);
    expect(heldEmptyReject(MINT, 1)).toBeUndefined();
    noteEmptyReading(MINT, 80, 0);
    expect(heldEmptyReject(MINT, 60 * 60_000 - 1)).toBe(80);
    expect(heldEmptyReject(MINT, 60 * 60_000)).toBeUndefined();
  });
});
