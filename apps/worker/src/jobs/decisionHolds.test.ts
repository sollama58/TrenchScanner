import { describe, expect, it } from "vitest";
import {
  DECISION_HOLD_REASONS,
  noteDecisionHold,
  resetDecisionHolds,
  takeDecisionHolds,
} from "./decisionHolds.js";

describe("decision hold counters", () => {
  it("counts holds per cycle and since boot", () => {
    resetDecisionHolds();
    noteDecisionHold("sniperWait");
    noteDecisionHold("sniperWait");
    noteDecisionHold("preGate5m");
    const first = takeDecisionHolds();
    expect(Object.keys(first.cycle)).toEqual([...DECISION_HOLD_REASONS]);
    expect(first.cycle).toMatchObject({ sniperWait: 2, preGate5m: 1, walletChecks: 0, linkedWait: 0 });
    noteDecisionHold("walletChecks");
    const second = takeDecisionHolds();
    expect(second.cycle).toMatchObject({ sniperWait: 0, preGate5m: 0, walletChecks: 1 });
    expect(second.sinceBoot).toMatchObject({ sniperWait: 2, preGate5m: 1, walletChecks: 1, linkedWait: 0 });
    // A read hands out copies: the running totals can't be changed through them.
    second.sinceBoot.sniperWait = 99;
    expect(takeDecisionHolds().sinceBoot.sniperWait).toBe(2);
  });
});
