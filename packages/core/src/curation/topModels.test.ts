import { describe, expect, it } from "vitest";
import {
  pickBestReturnModel,
  pickTopModels,
  rankTopModels,
  servableTopModels,
  topModelsLowerBound,
  topModelsWindow,
  TOP_MODELS_RANK_MIN_GRADED,
} from "./topModels.js";
import {
  feedCallsKey,
  feedCallsWhere,
  highConvictionCalls,
  isFeedCall,
  resolveDefaultModels,
  resolveFeedCalls,
  resolveFeedModels,
  resolveTelegramModels,
} from "./feedModels.js";
import { CONTESTANTS } from "./contestants.js";

const N = TOP_MODELS_RANK_MIN_GRADED;
const s = (id: string, wins: number, graded: number, calling = true) => ({ id, wins, graded, calling });

describe("pickTopModels", () => {
  it("ranks by the 2x lower bound, so a short hot streak loses to a longer good record", () => {
    // "hot" hits 2x on 28% of a short record; "steady" on 25% of four times as many calls.
    const hot = s("hot", Math.round(0.28 * N), N);
    const steady = s("steady", N, 4 * N);
    expect(topModelsLowerBound(steady)).toBeGreaterThan(topModelsLowerBound(hot));
    expect(
      pickTopModels([hot, steady, s("c", Math.round(0.2 * N), N), s("d", Math.round(0.1 * N), N)]),
    ).toEqual(["steady", "hot", "c"]);
  });

  it("ranks best first on equal volume, which is the 2x rate", () => {
    expect(pickTopModels([s("a", 10, N), s("b", 20, N), s("c", 15, N), s("d", 5, N)])).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("skips models under the graded-call floor and models that can't call", () => {
    const lucky = s("lucky", 2, 2);
    const silent = s("silent", N, N, false);
    expect(pickTopModels([lucky, silent, s("a", 10, N), s("b", 9, N), s("c", 8, N)])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(pickTopModels([s("a", N - 1, N - 1), s("b", 9, N), s("c", 8, N), s("d", 1, N)])).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("returns null when fewer than three qualify", () => {
    expect(pickTopModels([s("a", 10, N), s("b", 9, N), s("c", 9, 5)])).toBeNull();
  });

  it("breaks ties on the longer record, then the id", () => {
    expect(rankTopModels([s("b", 0, N), s("a", 0, N), s("c", 0, 2 * N)])).toEqual(["c", "a", "b"]);
  });
});

describe("servableTopModels", () => {
  const ranked = ["a", "b", "c", "d", "e"];

  it("serves the held pick whole while every model can call", () => {
    expect(servableTopModels(["c", "a", "b"], ranked, ranked)).toEqual(["c", "a", "b"]);
  });

  it("gives a model that can't call its place to the next-ranked one that can", () => {
    expect(servableTopModels(["a", "b", "c"], ["a", "c", "d", "e"], ranked)).toEqual(["a", "c", "d"]);
    // d can't call either: e.
    expect(servableTopModels(["a", "b", "c"], ["a", "c", "e"], ranked)).toEqual(["a", "c", "e"]);
  });

  it("keeps what it can when nothing ranked can fill in, and nothing when nothing can call", () => {
    expect(servableTopModels(["a", "b", "c"], ["a"], ["a", "b", "c"])).toEqual(["a"]);
    expect(servableTopModels(["a", "b", "c"], [], ranked)).toBeNull();
  });

  it("leaves an empty pick (too few qualified at the slot's start) empty", () => {
    expect(servableTopModels([], ranked, ranked)).toBeNull();
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
  it("aligns the windows to the 6-hour slot, ending before calls still being graded", () => {
    const a = topModelsWindow(new Date("2026-10-12T06:00:00Z"));
    const b = topModelsWindow(new Date("2026-10-12T11:59:59Z"));
    expect(a).toEqual(b);
    expect(new Date(a.slot).toISOString()).toBe("2026-10-12T06:00:00.000Z");
    expect(a.until.toISOString()).toBe("2026-10-12T05:15:00.000Z");
    expect(a.since.toISOString()).toBe("2026-10-11T05:15:00.000Z");
    expect(a.rankSince.toISOString()).toBe("2026-10-09T05:15:00.000Z");
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
    defaultModels: resolveDefaultModels(["trees", "linear", "rules"], "rules", "rules"),
    bestModel: null,
  };

  it("falls back to the single default when no model qualifies", () => {
    expect(resolveDefaultModels(null, "rules", "rules")).toEqual(["rules"]);
    expect(resolveDefaultModels([], "rules", "rules")).toEqual(["rules"]);
  });

  it("is the top 3 plus the champion when it did not rank in: 4 at most", () => {
    expect(resolveDefaultModels(["trees", "linear", "forest"], "rules", "rules")).toEqual([
      "trees",
      "linear",
      "forest",
      "rules",
    ]);
    expect(resolveDefaultModels(["trees", "rules", "forest"], "rules", "rules")).toEqual([
      "trees",
      "rules",
      "forest",
    ]);
  });

  it("keeps a short pick and adds the champion", () => {
    expect(resolveDefaultModels(["trees", "linear"], "rules", "rules")).toEqual(["trees", "linear", "rules"]);
    expect(resolveDefaultModels(["rules"], "rules", "rules")).toEqual(["rules"]);
  });

  it("does not pin a fallback standing in for a silent champion", () => {
    expect(resolveDefaultModels(["trees", "linear", "forest"], "consensus", "rules")).toEqual([
      "trees",
      "linear",
      "forest",
    ]);
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

  it("sends Telegram the Live Feed's models until it gets its own picks", () => {
    const feed = { model: "linear", models: ["linear"], followBest: false, showModelAlerts: true };
    const same = { sameAsFeed: true, models: ["trees"] };
    expect(resolveTelegramModels(state, feed, same)).toEqual({ models: ["linear"], followsDefault: false });
    // Following the feed, the feed's off switch means no calls on Telegram either.
    expect(resolveTelegramModels(state, { ...feed, showModelAlerts: false }, same).models).toEqual([]);
    // Its own picks, in roster order, whatever the feed shows or whether it shows calls at all.
    const own = { sameAsFeed: false, models: ["trees", "rules"] };
    expect(resolveTelegramModels(state, { ...feed, showModelAlerts: false }, own)).toEqual({
      models: ["rules", "trees"],
      followsDefault: false,
    });
    // No picks, or none left on the roster: the top models.
    expect(resolveTelegramModels(state, feed, { sameAsFeed: false, models: [] })).toEqual({
      models: ["trees", "linear", "rules"],
      followsDefault: true,
    });
    expect(resolveTelegramModels(state, feed, { sameAsFeed: false, models: ["gone"] }).followsDefault).toBe(
      true,
    );
  });
});

describe("high-conviction tier", () => {
  const roster = CONTESTANTS.filter((c) => ["rules", "linear", "trees"].includes(c.id));

  it("is every roster model's high calls, whatever the reader follows", () => {
    const calls = highConvictionCalls({ roster });
    expect(calls).toEqual({ models: roster.map((c) => c.id), tier: "high" });
    expect(resolveFeedCalls({ roster }, ["linear"], true)).toEqual(calls);
    expect(feedCallsWhere(calls)).toEqual({ model: { in: calls.models }, tier: "high" });
    expect(isFeedCall(calls, { model: "trees", tier: "high" })).toBe(true);
    expect(isFeedCall(calls, { model: "trees", tier: "standard" })).toBe(false);
    expect(isFeedCall(calls, { model: "gone", tier: "high" })).toBe(false);
  });

  it("leaves a reader's own feed calls untiered when not asked for", () => {
    const calls = resolveFeedCalls({ roster }, ["linear", "trees"], false);
    expect(calls).toEqual({ models: ["linear", "trees"], tier: null });
    expect(feedCallsWhere(calls)).toEqual({ model: { in: ["linear", "trees"] } });
    expect(isFeedCall(calls, { model: "trees", tier: null })).toBe(true);
    expect(isFeedCall(calls, { model: "rules", tier: null })).toBe(false);
  });

  it("keys the two apart, with the model list last", () => {
    const own = resolveFeedCalls({ roster }, ["linear", "trees"], false);
    const high = highConvictionCalls({ roster });
    expect(feedCallsKey(own)).toBe("linear,trees");
    expect(feedCallsKey(high)).not.toBe(feedCallsKey({ ...high, tier: null }));
    expect(feedCallsKey(high).split(":").at(-1)).toBe(high.models.join(","));
  });
});
