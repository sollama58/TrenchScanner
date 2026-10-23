import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import {
  columnLabel,
  frameOf,
  holdFrame,
  mergeCalls,
  scopeTickIds,
  shortAge,
  splitScope,
  swipeStep,
  type ScopeColumnSpec,
} from "./scope";

/** Just the fields Scope's columns read. */
function card(id: string, kind: Card["kind"], curated = false, tokenId = `t-${id}`): Card {
  return {
    id,
    kind,
    tokenId,
    snapshot: {},
    latestSnapshot: null,
    curated: curated ? ({ alertId: id } as Card["curated"]) : null,
  } as Card;
}

type Fixed = Record<"filters" | "models" | "new" | "soon" | "graduated", Card[]>;

/** The board of every fixed column, as boards were before columns could be chosen. */
function split(
  feed: Card[],
  graduated: Card[],
  keep: { filters: boolean; models: boolean } = { filters: false, models: false },
  stream: Card[] = [],
): Fixed {
  const col = (kind: ScopeColumnSpec["kind"], keepGraduated = false) => ({
    id: kind,
    kind,
    picks: [],
    keepGraduated,
  });
  return splitScope(
    [col("filters", keep.filters), col("models", keep.models), col("new"), col("soon"), col("graduated")],
    { feed, graduated, stream },
  ) as Fixed;
}

describe("splitScope", () => {
  it("puts filter alerts, model calls and graduated tokens in their columns, keeping order", () => {
    const feed = [card("m1", "match"), card("c1", "curated", true), card("m2", "match")];
    const cols = split(feed, [card("g1", "stream")]);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(cols.models.map((c) => c.id)).toEqual(["c1"]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
  });

  it("shows a token a filter and a model both alerted on only in the column that alerted first", () => {
    const both = (matchedAt: string, alertedAt: string) =>
      ({ ...card("m1", "match"), matchedAt, curated: { alertId: "a", alertedAt } }) as Card;
    let cols = split([both("2026-10-19T01:00:00Z", "2026-10-19T01:05:00Z")], []);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models).toEqual([]);
    cols = split([both("2026-10-19T01:05:00Z", "2026-10-19T01:00:00Z")], []);
    expect(cols.filters).toEqual([]);
    expect(cols.models.map((c) => c.id)).toEqual(["m1"]);
    // Separate cards for one token: the model's call came first, so the filter's alert stays out.
    const filterAlert = { ...card("m2", "match", false, "t-x"), matchedAt: "2026-10-19T01:05:00Z" } as Card;
    const modelCall = {
      ...card("c2", "curated", false, "t-x"),
      matchedAt: "2026-10-19T01:00:00Z",
      curated: { alertId: "c2", alertedAt: "2026-10-19T01:00:00Z" },
    } as Card;
    cols = split([filterAlert, modelCall], []);
    expect(cols.filters).toEqual([]);
    expect(cols.models.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("chosen columns", () => {
  const filtered = (id: string, filterId: string, tokenId = `t-${id}`): Card =>
    ({ ...card(id, "match", false, tokenId), filter: { id: filterId, name: filterId } }) as Card;
  const call = (id: string, model: string, alertedAt: string, tokenId = `t-${id}`): Card =>
    ({
      ...card(id, "curated", false, tokenId),
      matchedAt: alertedAt,
      curated: { alertId: id, alertedAt, model },
    }) as Card;

  it("shows only the picked filters' alerts in a specific filters column", () => {
    const feed = [filtered("a", "f1"), filtered("b", "f2"), filtered("c", "f3")];
    const cols = splitScope([{ id: "x", kind: "filter", picks: ["f1", "f3"] }], { feed, graduated: [] });
    expect(cols.x!.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("merges picked models' calls newest first, each token once", () => {
    const modelCalls = new Map([
      ["m1", [call("a", "m1", "2026-10-23T10:05:00Z"), call("b", "m1", "2026-10-23T10:00:00Z", "tok")]],
      ["m2", [call("c", "m2", "2026-10-23T10:03:00Z", "tok")]],
    ]);
    const cols = splitScope([{ id: "x", kind: "model", picks: ["m1", "m2"] }], {
      feed: [],
      graduated: [],
      modelCalls,
    });
    expect(cols.x!.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("leaves graduated alerts in place when the board has no Graduated column", () => {
    const alert = { ...card("m1", "match"), snapshot: { graduated: true } } as Card;
    const cols = splitScope([{ id: "filters", kind: "filters", picks: [] }], {
      feed: [alert],
      graduated: [],
    });
    expect(cols.filters!.map((c) => c.id)).toEqual(["m1"]);
  });

  it("fills every Graduated column and each New column alike", () => {
    const cols = splitScope(
      [
        { id: "graduated", kind: "graduated", picks: [] },
        { id: "graduated-2", kind: "graduated", picks: [] },
        { id: "new", kind: "new", picks: [] },
      ],
      { feed: [], graduated: [card("g1", "stream")], stream: [card("s1", "stream")] },
    );
    expect(cols.graduated!.map((c) => c.id)).toEqual(["g1"]);
    expect(cols["graduated-2"]!.map((c) => c.id)).toEqual(["g1"]);
    expect(cols.new!.map((c) => c.id)).toEqual(["s1"]);
  });

  it("keeps a token on the side that alerted first, specific models too", () => {
    const alert = { ...filtered("m1", "f1", "tok"), matchedAt: "2026-10-23T10:05:00Z" } as Card;
    const modelCalls = new Map([["m9", [call("c1", "m9", "2026-10-23T10:00:00Z", "tok")]]]);
    const cols = splitScope(
      [
        { id: "filters", kind: "filters", picks: [] },
        { id: "model", kind: "model", picks: ["m9"] },
      ],
      { feed: [alert], graduated: [], modelCalls },
    );
    expect(cols.filters).toEqual([]);
    expect(cols.model!.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("mergeCalls", () => {
  it("sorts by alert time across lists", () => {
    const at = (id: string, iso: string) =>
      ({ ...card(id, "curated"), curated: { alertId: id, alertedAt: iso } }) as Card;
    const merged = mergeCalls([[at("a", "2026-10-23T09:00:00Z")], [at("b", "2026-10-23T11:00:00Z")]]);
    expect(merged.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("columnLabel", () => {
  const names = new Map([
    ["f1", "Fast"],
    ["f2", "Deep"],
    ["f3", "KOL"],
  ]);
  it("names a column by its kind, or by its picks", () => {
    expect(columnLabel({ id: "a", kind: "graduated", picks: [] }, names)).toBe("Graduated");
    expect(columnLabel({ id: "b", kind: "filter", picks: [] }, names)).toBe("Specific filters");
    expect(columnLabel({ id: "c", kind: "filter", picks: ["f1", "f2"] }, names)).toBe("Fast + Deep");
    expect(columnLabel({ id: "d", kind: "filter", picks: ["f1", "f2", "f3"] }, names)).toBe("Fast +2");
    expect(columnLabel({ id: "e", kind: "model", picks: ["unknown"] }, names)).toBe("Model");
  });
});

describe("graduated alerts", () => {
  const grad = (c: Card): Card => ({ ...c, snapshot: { graduated: true }, latestSnapshot: null }) as Card;
  const at = (c: Card, iso: string): Card => ({ ...c, matchedAt: iso }) as Card;

  it("moves an alert whose coin graduated to the Graduated column, in its coin's place", () => {
    const alert = at(card("m1", "match", true, "tok"), "2026-10-18T10:00:00Z");
    const entry = at(card("g1", "stream", false, "tok"), "2026-10-18T11:00:00Z");
    const other = at(card("g2", "stream"), "2026-10-18T12:00:00Z");
    const cols = split([alert], [other, entry]);
    expect(cols.filters).toEqual([]);
    expect(cols.models).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g2", "m1"]);
  });

  it("moves one its own scans call graduated, by its alert time", () => {
    const alert = grad(at(card("m1", "match"), "2026-10-18T11:30:00Z"));
    const older = at(card("g1", "stream"), "2026-10-18T11:00:00Z");
    const cols = split([alert, at(card("m2", "match"), "2026-10-18T11:40:00Z")], [older]);
    expect(cols.filters.map((c) => c.id)).toEqual(["m2"]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["m1", "g1"]);
  });

  it("keeps it in its own column too when the column shows graduated alerts", () => {
    const alert = grad(at(card("m1", "match", true), "2026-10-18T11:30:00Z"));
    const cols = split([alert], [], { filters: true, models: false });
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["m1"]);
  });
});

describe("the Stream's columns", () => {
  const priced = (c: Card, mcap: number): Card =>
    ({ ...c, snapshot: { marketCapUsd: mcap }, currentMarketCapUsd: null }) as Card;

  it("shows New's tokens in About to graduate too, closest to graduating first", () => {
    const stream = [
      priced(card("s1", "stream"), 12_000),
      priced(card("s2", "stream"), 50_000),
      priced(card("s3", "stream"), 6_000),
      priced(card("s4", "stream"), 61_000),
    ];
    const cols = split([], [], undefined, stream);
    expect(cols.new.map((c) => c.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(cols.soon.map((c) => c.id)).toEqual(["s4", "s2", "s1", "s3"]);
  });

  it("ranks About to graduate by the live market cap over the scan's", () => {
    const live = { ...priced(card("s1", "stream"), 10_000), currentMarketCapUsd: 70_000 } as Card;
    const cols = split([], [], undefined, [priced(card("s2", "stream"), 40_000), live]);
    expect(cols.soon.map((c) => c.id)).toEqual(["s1", "s2"]);
  });

  it("leaves a graduated token to the Graduated column", () => {
    const entry = card("g1", "stream", false, "tok");
    const cols = split([], [entry], undefined, [priced(card("s1", "stream", false, "tok"), 80_000)]);
    expect(cols.new).toEqual([]);
    expect(cols.soon).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
  });
});

describe("holdFrame", () => {
  it("keeps rows in place while paused and counts the new ones once", () => {
    const before = split([card("m1", "match"), card("c1", "curated", true)], []);
    const frame = frameOf(before);
    const newer = card("m0", "match", true);
    const fresh = split([newer, ...before.filters, ...before.models], [card("g1", "stream")]);
    const { cols: held, pending } = holdFrame(frame, fresh, new Map());
    const cols = held as Fixed;
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models.map((c) => c.id)).toEqual(["c1"]);
    // Graduated was empty when paused (not loaded yet): it fills in rather than waiting.
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
    // m0 is new in two columns but one alert.
    expect(pending).toBe(1);
  });

  it("keeps a row whose alert left the feed, from its last card", () => {
    const gone = card("m1", "match");
    const frame = frameOf(split([gone], []));
    const cols = holdFrame(frame, split([], []), new Map([["m1", gone]])).cols as Fixed;
    expect(cols.filters).toEqual([gone]);
  });
});

describe("scopeTickIds", () => {
  it("takes each column's top rows in turn, within the tick's limit", () => {
    const filters = Array.from({ length: 20 }, (_, i) => card(`m${i}`, "match"));
    const models = Array.from({ length: 20 }, (_, i) => card(`c${i}`, "curated", true));
    const ids = scopeTickIds({ filters, models, new: [], soon: [], graduated: [card("g0", "stream")] });
    expect(ids.slice(0, 4)).toEqual(["t-m0", "t-c0", "t-g0", "t-m1"]);
    expect(ids).toHaveLength(30);
  });
});

describe("shortAge", () => {
  it("says seconds, minutes, hours, then days", () => {
    expect(shortAge(14_000)).toBe("14s");
    expect(shortAge(3 * 60_000 + 5_000)).toBe("3m");
    expect(shortAge(2 * 3_600_000)).toBe("2h");
    expect(shortAge(3 * 86_400_000)).toBe("3d");
    expect(shortAge(-5)).toBe("0s");
  });
});

describe("swipeStep", () => {
  it("moves a column on a sideways swipe", () => {
    expect(swipeStep(-80, 10)).toBe(1);
    expect(swipeStep(90, -20)).toBe(-1);
  });
  it("ignores taps and swipes that are mostly up or down", () => {
    expect(swipeStep(-20, 0)).toBe(0);
    expect(swipeStep(-80, 60)).toBe(0);
    expect(swipeStep(0, 300)).toBe(0);
  });
});
