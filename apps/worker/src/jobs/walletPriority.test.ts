import { beforeEach, describe, expect, it } from "vitest";
import {
  alertAwaitingWallets,
  clearFilterWalletWait,
  filterWalletWaitOver,
  noteAlertWallets,
  resetAlertWallets,
} from "./walletPriority.js";

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

describe("filter matches held for a wallet figure", () => {
  beforeEach(() => resetAlertWallets());

  it("holds for the wait, queues the token for its wallets meanwhile, and lets go once over", () => {
    const t0 = Date.now();
    expect(filterWalletWaitOver("mint", 180_000, t0)).toBe(false);
    expect(alertAwaitingWallets("mint", t0)).toBe(true);
    expect(filterWalletWaitOver("mint", 180_000, t0 + 60_000)).toBe(false);
    expect(filterWalletWaitOver("mint", 180_000, t0 + 180_000)).toBe(true);
    clearFilterWalletWait("mint");
    expect(alertAwaitingWallets("mint", t0 + 180_000)).toBe(false);
  });

  it("doesn't wait at all with a zero wait", () => {
    expect(filterWalletWaitOver("mint", 0)).toBe(true);
  });

  it("starts afresh on a hold forgotten for an hour", () => {
    const t0 = Date.now();
    filterWalletWaitOver("mint", 180_000, t0);
    expect(alertAwaitingWallets("mint", t0 + 61 * 60_000)).toBe(false);
    expect(filterWalletWaitOver("mint", 180_000, t0 + 62 * 60_000)).toBe(false);
  });
});
