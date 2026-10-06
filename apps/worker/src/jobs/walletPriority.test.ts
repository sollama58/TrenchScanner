import { beforeEach, describe, expect, it } from "vitest";
import { alertAwaitingWallets, noteAlertWallets, resetAlertWallets } from "./walletPriority.js";

describe("alerted tokens awaiting their wallet readings", () => {
  beforeEach(() => resetAlertWallets());

  it("queues a token alerted on without an empty-wallet reading, and clears it once one lands", () => {
    noteAlertWallets("mint", false, false);
    expect(alertAwaitingWallets("mint")).toBe(false);
    noteAlertWallets("mint", true, false);
    expect(alertAwaitingWallets("mint")).toBe(true);
    // A later scan without an alert doesn't drop it; a reading does.
    noteAlertWallets("mint", false, false);
    expect(alertAwaitingWallets("mint")).toBe(true);
    noteAlertWallets("mint", false, true);
    expect(alertAwaitingWallets("mint")).toBe(false);
  });

  it("lets a queued token lapse after six hours", () => {
    const t0 = Date.now();
    noteAlertWallets("mint", true, false, t0);
    expect(alertAwaitingWallets("mint", t0 + 5 * 3_600_000)).toBe(true);
    expect(alertAwaitingWallets("mint", t0 + 7 * 3_600_000)).toBe(false);
  });
});
