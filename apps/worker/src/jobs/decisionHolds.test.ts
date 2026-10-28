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
    noteDecisionHold("launchReadWait");
    noteDecisionHold("launchReadWait");
    noteDecisionHold("preGate5m");
    const first = takeDecisionHolds();
    expect(Object.keys(first.cycle)).toEqual([...DECISION_HOLD_REASONS]);
    expect(first.cycle).toMatchObject({ launchReadWait: 2, preGate5m: 1, walletChecks: 0, linkedWait: 0 });
    noteDecisionHold("walletChecks");
    const second = takeDecisionHolds();
    expect(second.cycle).toMatchObject({ launchReadWait: 0, preGate5m: 0, walletChecks: 1 });
    expect(second.sinceBoot).toMatchObject({
      launchReadWait: 2,
      preGate5m: 1,
      walletChecks: 1,
      linkedWait: 0,
    });
    // A read hands out copies: the running totals can't be changed through them.
    second.sinceBoot.launchReadWait = 99;
    expect(takeDecisionHolds().sinceBoot.launchReadWait).toBe(2);
  });
});
