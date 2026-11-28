import { afterEach, describe, expect, it } from "vitest";
import { calibratedRateTitle } from "./rates";
import {
  CLASSIC_WIN_TARGET,
  setWinTargetForTest,
  winRuleLong,
  winRuleShort,
  winTargetNow,
} from "./winTarget";

const FILL30 = { rule: "fill30", windowMinutes: 30, multiple: 2, stopPct: 30, base: "fill" } as const;

afterEach(() => setWinTargetForTest(null));

describe("the site's win rule wording", () => {
  it("is the classic rule until the server says otherwise, in the words the pages always used", () => {
    expect(winTargetNow()).toEqual(CLASSIC_WIN_TARGET);
    expect(winRuleShort()).toBe("2x within 15 min of the alert, before a 50% stop");
    expect(winRuleLong()).toBe("2x on the alert price within 15 minutes of the alert, before a 50% drop");
    expect(calibratedRateTitle(41, false)).toContain("hit 2x within 15 min of the alert, before a 50% stop");
  });

  // Program audit 2026-11-28, card 1 step 3: with WIN_TARGET_RULE=fill30 the numbers are counted on
  // the fill target, and a hover that still said "15 min ... 50% stop" would state the wrong rule.
  it("states the fill target when the server reports it", () => {
    setWinTargetForTest(FILL30);
    expect(winRuleShort()).toBe(
      "2x on the price a buyer could get within 30 min of the alert, before a 30% stop",
    );
    expect(winRuleLong()).toContain("the price 16 seconds after the alert, plus 1%");
    const title = calibratedRateTitle(41, false);
    expect(title).toContain("within 30 min of the alert, before a 30% stop");
    expect(title).not.toContain("15 min");
  });
});
