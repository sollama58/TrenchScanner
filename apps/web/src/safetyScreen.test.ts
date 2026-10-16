import { describe, expect, it } from "vitest";
import type { Card, Snapshot } from "./api";
import { safetyChecks, safetyVerdict } from "./safetyScreen";

const snap = (over: Partial<Snapshot>): Snapshot =>
  ({ takenAt: "2026-10-16T00:00:00Z", marketCapUsd: 1, ...over }) as Snapshot;
const card = (snapshot: Snapshot, latestSnapshot: Snapshot | null = null): Card =>
  ({ id: "c", kind: "match", snapshot, latestSnapshot }) as unknown as Card;

describe("safety verdict", () => {
  it("is pending while the scan runs, or with no screened reading", () => {
    const passed = snap({ rugScreenPassed: true });
    expect(safetyVerdict(card(passed), true).state).toBe("pending");
    // A lookup's stand-in reading carries no verdict.
    expect(safetyVerdict(card(snap({})), false)).toMatchObject({ state: "pending", reading: null });
  });

  it("reads the newest scan, and says when the alert's reading passed", () => {
    const alert = snap({ rugScreenPassed: true });
    const later = snap({
      takenAt: "2026-10-16T00:05:00Z",
      rugScreenPassed: false,
      rugScreenReasons: ["largest holder owns 12.0% of supply (over 10%)"],
    });
    expect(safetyVerdict(card(alert, later), false)).toEqual({
      state: "failed",
      reading: later,
      reasons: ["Largest holder owns 12.0% of supply (over 10%)"],
      passedAtAlert: true,
    });
    expect(safetyVerdict(card(alert, alert), false)).toMatchObject({ state: "passed", passedAtAlert: false });
  });
});

describe("safety checks", () => {
  it("marks each rule against its cut, and unread ones as not read", () => {
    const checks = safetyChecks(
      snap({
        mintAuthorityActive: false,
        freezeAuthorityActive: true,
        lpBurned: true,
        top10HolderPct: 40,
        largestHolderPct: 10,
        freshTopHolderCount: 18,
        freshTopHoldersChecked: 25,
        linkedWalletCount: 16,
        linkedWalletsChecked: 19,
      }),
    );
    const by = Object.fromEntries(checks.map((c) => [c.label, c]));
    expect(by["Mint authority"]).toMatchObject({ value: "Renounced", status: "ok" });
    expect(by["Freeze authority"]).toMatchObject({ value: "Active", status: "fail" });
    expect(by["Liquidity"]).toMatchObject({ status: "ok" });
    expect(by["Mayhem Mode"]).toMatchObject({ value: "Not read", status: "unknown" });
    // At 40% the top-10 cut fails; at exactly 10% the largest holder passes.
    expect(by["Top 10 holders"]).toMatchObject({ value: "40%", status: "fail" });
    expect(by["Largest holder"]).toMatchObject({ value: "10.0%", status: "ok" });
    // 18 of 25 is 72%: over the 70% cut.
    expect(by["Fresh wallets"]).toMatchObject({ value: "18/25", status: "fail" });
    // 20 of 25 on 19 read is 16 of 19.
    expect(by["Linked holders"]).toMatchObject({
      value: "16/19",
      status: "fail",
      rule: "Fails at 16 of 19 or more",
    });
    expect(by["Exchange-funded"]).toMatchObject({ status: "unknown" });
  });
});
