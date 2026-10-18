import { describe, expect, it } from "vitest";
import {
  pickBestModel,
  pickTopModels,
  rankTopModels,
  servableTopModels,
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
const s = (id: string, score: number | null, graded: number, calling = true) => ({
  id,
  wins: 0,
  graded,
  calling,
  score,
});

describe("pickTopModels", () => {
  it("ranks by the composite score, best first", () => {
    expect(pickTopModels([s("a", 20, N), s("b", 31, N), s("c", 25, N), s("d", 12, N)])).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("skips models under the graded-call floor and models that can't call", () => {
    const lucky = s("lucky", 90, 2);
    const silent = s("silent", 80, N, false);
    expect(pickTopModels([lucky, silent, s("a", 30, N), s("b", 29, N), s("c", 28, N)])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(pickTopModels([s("a", 95, N - 1), s("b", 30, N), s("c", 20, N), s("d", 10, N)])).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("returns null when fewer than three qualify", () => {
    expect(pickTopModels([s("a", 30, N), s("b", 29, N), s("c", 29, 5)])).toBeNull();
  });

  it("breaks ties on the longer record, then the id; an unscored model ranks last", () => {
    expect(rankTopModels([s("b", 20, N), s("a", 20, N), s("c", 20, 2 * N), s("z", null, N)])).toEqual([
      "c",
      "a",
      "b",
      "z",
    ]);
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

describe("pickBestModel", () => {
  it("picks the best composite score over the floor", () => {
    expect(pickBestModel([s("a", 20, 40), s("b", 33, 40), s("c", 10, 40)])).toBe("b");
  });

  it("ignores a short lucky record and models that can't call", () => {
    expect(pickBestModel([s("a", 20, 40), s("lucky", 90, 2), s("silent", 50, 40, false)])).toBe("a");
    expect(pickBestModel([s("lucky", 90, 2)])).toBeNull();
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
