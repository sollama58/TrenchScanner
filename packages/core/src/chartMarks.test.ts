import { describe, expect, it } from "vitest";
import {
  CHART_MARK_KINDS,
  CHART_MARKS_REV,
  DEFAULT_CHART_MARK_KINDS,
  reviseChartMarkKinds,
  type ChartMarkKind,
} from "./chartMarks.js";

const all = [...CHART_MARK_KINDS] as ChartMarkKind[];
const rev2 = all.filter((k) => k !== "risky");

describe("reviseChartMarkKinds", () => {
  it("keeps risky and winner on a look saved at revision 3", () => {
    // 2026-10-21 user ask: revision 3 is explicit. Saving every kind at that revision is the
    // reader turning both back on, and the next read keeps both.
    expect(reviseChartMarkKinds(all, CHART_MARKS_REV)).toEqual(all);
    expect(reviseChartMarkKinds(all, 3)).toContain("risky");
    expect(reviseChartMarkKinds(all, 3)).toContain("winner");
  });

  it("drops risky and winners from an untouched older default, and winners from rev 2", () => {
    expect(reviseChartMarkKinds(all, undefined)).not.toContain("risky");
    expect(reviseChartMarkKinds(all, undefined)).not.toContain("winner");
    const riskyOn = reviseChartMarkKinds(all, 2);
    expect(riskyOn).toContain("risky");
    expect(riskyOn).not.toContain("winner");
    expect(reviseChartMarkKinds(rev2, 2)).not.toContain("winner");
  });

  it("keeps a list the reader edited", () => {
    expect(reviseChartMarkKinds(["kol", "risky"], undefined)).toEqual(["kol", "risky"]);
    expect(reviseChartMarkKinds(["kol", "winner"], 2)).toEqual(["kol", "winner"]);
  });

  it("leaves the default as every kind but risky and winner", () => {
    expect(DEFAULT_CHART_MARK_KINDS).not.toContain("risky");
    expect(DEFAULT_CHART_MARK_KINDS).not.toContain("winner");
    expect(DEFAULT_CHART_MARK_KINDS).toHaveLength(6);
  });
});
