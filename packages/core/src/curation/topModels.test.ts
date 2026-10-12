import { describe, expect, it } from "vitest";
import { pickBestReturnModel, pickTopModels, topModelsWindow, TOP_MODELS_MIN_GRADED } from "./topModels.js";
import { resolveDefaultModels, resolveFeedModels } from "./feedModels.js";
import { CONTESTANTS } from "./contestants.js";

const s = (id: string, wins: number, graded: number, calling = true, score: number | null = wins) => ({
  id,
  wins,
  graded,
  calling,
  score,
});

describe("pickTopModels", () => {
  it("ranks by score, not by the 24h 2x rate", () => {
    // "hot" hit 2x on 45% of its last day but scores 30; the others hit less often and score more.
    const hot = s("hot", 18, 40, true, 30);
    expect(
      pickTopModels([hot, s("a", 10, 40, true, 39), s("b", 11, 40, true, 38), s("c", 9, 40, true, 36)]),
    ).toEqual(["a", "b", "c"]);
  });

  it("puts a model with no score last, then breaks ties on the 2x rate", () => {
    expect(
      pickTopModels([
        s("none", 30, 40, true, null),
        s("a", 10, 40, true, 35),
        s("b", 12, 40, true, 35),
        s("c", 1, 40, true, 20),
      ]),
    ).toEqual(["b", "a", "c"]);
  });

  it("ranks best first", () => {
    expect(pickTopModels([s("a", 10, 40), s("b", 20, 40), s("c", 15, 40), s("d", 5, 40)])).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("skips models under the graded-call floor and models that can't call", () => {
    const lucky = s("lucky", 2, 2);
    const silent = s("silent", 30, 40, false);
    expect(pickTopModels([lucky, silent, s("a", 10, 40), s("b", 9, 40), s("c", 8, 40)])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      pickTopModels([s("a", 10, TOP_MODELS_MIN_GRADED - 1), s("b", 9, 40), s("c", 8, 40), s("d", 1, 40)]),
    ).toEqual(["b", "c", "d"]);
  });

  it("returns null when fewer than three qualify", () => {
    expect(pickTopModels([s("a", 10, 40), s("b", 9, 40), s("c", 9, 5)])).toBeNull();
  });

  it("breaks ties on the longer record", () => {
    expect(pickTopModels([s("a", 10, 40), s("b", 20, 80), s("c", 1, 40), s("d", 2, 40)])).toEqual([
      "b",
      "a",
      "d",
    ]);
  });
});

describe("pickBestReturnModel", () => {
  const r = (id: string, avg: number, graded = 40, calling = true) => ({
    id,
    wins: 0,
    graded,
    calling,
    simCalls: graded,
    sumSimReturnPct: avg * graded,
  });

  it("picks the best average exit-plan return over the floor", () => {
    expect(pickBestReturnModel([r("a", 5), r("b", 12), r("c", -3)])).toBe("b");
  });

  it("ignores a short lucky record and models that can't call", () => {
    expect(pickBestReturnModel([r("a", 5), r("lucky", 300, 2), r("silent", 50, 40, false)])).toBe("a");
    expect(pickBestReturnModel([r("lucky", 300, 2)])).toBeNull();
  });
});

describe("topModelsWindow", () => {
  it("aligns the 24h window to the 6-hour slot, ending before calls still being graded", () => {
    const a = topModelsWindow(new Date("2026-10-12T06:00:00Z"));
    const b = topModelsWindow(new Date("2026-10-12T11:59:59Z"));
    expect(a).toEqual(b);
    expect(new Date(a.slot).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(a.until.toISOString()).toBe("2026-10-12T05:15:00.000Z");
    expect(a.since.toISOString()).toBe("2026-10-11T05:15:00.000Z");
    // The next slot starts at 12:00 UTC.
    expect(new Date(topModelsWindow(new Date("2026-10-12T12:00:00Z")).slot).toISOString()).toBe(
      "2026-10-12T12:00:00.000Z",
    );
  });
});

describe("default feed", () => {
  const roster = CONTESTANTS.filter((c) => ["rules", "linear", "trees"].includes(c.id));
  const state = {
    roster,
    defaultModel: "rules",
    defaultModels: resolveDefaultModels(["trees", "linear", "rules"], "rules"),
    bestModel: null,
  };

  it("falls back to the single default when too few models qualify", () => {
    expect(resolveDefaultModels(null, "rules")).toEqual(["rules"]);
  });

  it("is what a follower and a reader with no picks see", () => {
    expect(resolveFeedModels(state, { model: "linear", models: ["linear"], followBest: true })).toEqual({
      models: ["trees", "linear", "rules"],
      followsDefault: true,
    });
    expect(resolveFeedModels(state, { model: null, models: [], followBest: false })).toEqual({
      models: ["trees", "linear", "rules"],
      followsDefault: true,
    });
    expect(resolveFeedModels(state, { model: "linear", models: [], followBest: false })).toEqual({
      models: ["linear"],
      followsDefault: false,
    });
  });
});
