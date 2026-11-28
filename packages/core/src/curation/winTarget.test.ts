import { afterEach, describe, expect, it } from "vitest";
import { FILL_NET_FACTOR } from "./fillTarget.js";
import {
  describeWinTarget,
  fillStoppedByReturn,
  setWinTargetRule,
  winTargetRule,
  winTargetShort,
  winTargetSpec,
  wonSql,
  wonUnder,
} from "./winTarget.js";

afterEach(() => setWinTargetRule("classic"));

describe("the reported win rule", () => {
  it("is the classic rule until the switch says otherwise", () => {
    expect(winTargetRule()).toBe("classic");
    expect(winTargetSpec()).toEqual({
      rule: "classic",
      windowMinutes: 15,
      multiple: 2,
      stopPct: 50,
      base: "alert",
    });
    expect(winTargetShort()).toBe("2x in 15m");
    // The sentence the hit-rate report carried before the switch existed, word for word.
    expect(describeWinTarget()).toBe(
      "2x on the alert price within 15 minutes of the alert, without first falling 50% below it",
    );
  });

  it("describes the fill target when switched", () => {
    setWinTargetRule("fill30");
    expect(winTargetSpec()).toEqual({
      rule: "fill30",
      windowMinutes: 30,
      multiple: 2,
      stopPct: 30,
      base: "fill",
    });
    expect(winTargetShort()).toBe("2x in 30m from a real fill");
    expect(describeWinTarget()).toContain(
      "within 30 minutes of the alert, without first falling 30% below it",
    );
  });
});

describe("wonUnder", () => {
  // A call that doubled on the alert price but lost on the fill, and the reverse.
  const classicOnly = { hit2xIn1h: true, disqualified: false, fillWin: false };
  const fillOnly = { hit2xIn1h: false, disqualified: false, fillWin: true };

  it("reads the classic verdict by default, whatever the fill says", () => {
    expect(wonUnder(classicOnly)).toBe(true);
    expect(wonUnder(fillOnly)).toBe(false);
    expect(wonUnder({ hit2xIn1h: true, disqualified: true, fillWin: true })).toBe(false);
    expect(wonUnder({ hit2xIn1h: null, disqualified: null, fillWin: true })).toBeNull();
  });

  it("reads the fill verdict under fill30", () => {
    expect(wonUnder(classicOnly, "fill30")).toBe(false);
    expect(wonUnder(fillOnly, "fill30")).toBe(true);
  });

  it("keeps the classic verdict under fill30 on a call with no fill", () => {
    expect(wonUnder({ hit2xIn1h: true, disqualified: false, fillWin: null }, "fill30")).toBe(true);
    expect(wonUnder({ hit2xIn1h: true, disqualified: true }, "fill30")).toBe(false);
    expect(wonUnder({ hit2xIn1h: null, disqualified: null, fillWin: null }, "fill30")).toBeNull();
  });
});

describe("wonSql", () => {
  it("is the clean-double test the reports always ran, on the classic rule", () => {
    expect(wonSql(["co."], "classic").sql).toBe(
      '(co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false))',
    );
    expect(wonSql(["a.", "co."], "classic").sql).toBe(
      '(COALESCE(a."hit2xIn1h", co."hit2xIn1h") AND NOT COALESCE(a."disqualified", co."disqualified", false))',
    );
    expect(wonSql().sql).toBe('("hit2xIn1h" AND NOT COALESCE("disqualified", false))');
  });

  it("reads the fill verdict first under fill30, the classic one where there is none", () => {
    expect(wonSql(["co."], "fill30").sql).toBe(
      'COALESCE(co."fillWin", (co."hit2xIn1h" AND NOT COALESCE(co."disqualified", false)))',
    );
    expect(wonSql(["a.", "co."], "fill30").sql).toContain('COALESCE(a."fillWin", co."fillWin", (COALESCE(');
  });
});

describe("fillStoppedByReturn", () => {
  it("tells a stop-out from a trade that ran out of time by the stored return", () => {
    const atStop = (0.7 * FILL_NET_FACTOR - 1) * 100;
    expect(fillStoppedByReturn(atStop)).toBe(true);
    expect(fillStoppedByReturn(atStop - 20)).toBe(true);
    expect(fillStoppedByReturn(atStop + 0.5)).toBe(false);
    expect(fillStoppedByReturn(94)).toBe(false);
    expect(fillStoppedByReturn(null)).toBe(false);
  });
});
