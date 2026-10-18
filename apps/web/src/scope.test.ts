import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { frameOf, holdFrame, scopeTickIds, shortAge, splitScope } from "./scope";

/** Just the fields Scope's columns read. */
function card(id: string, kind: Card["kind"], curated = false, tokenId = `t-${id}`): Card {
  return { id, kind, tokenId, curated: curated ? ({ alertId: id } as Card["curated"]) : null } as Card;
}

describe("splitScope", () => {
  it("puts filter alerts, model calls and graduated tokens in their columns, keeping order", () => {
    const feed = [card("m1", "match"), card("c1", "curated", true), card("m2", "match")];
    const cols = splitScope(feed, [card("g1", "stream")]);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(cols.models.map((c) => c.id)).toEqual(["c1"]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
  });

  it("shows a filter alert a model call folded into in both columns", () => {
    const cols = splitScope([card("m1", "match", true)], []);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models.map((c) => c.id)).toEqual(["m1"]);
  });
});

describe("holdFrame", () => {
  it("keeps rows in place while paused and counts the new ones once", () => {
    const before = splitScope([card("m1", "match"), card("c1", "curated", true)], []);
    const frame = frameOf(before);
    const newer = card("m0", "match", true);
    const fresh = splitScope([newer, ...before.filters, ...before.models], [card("g1", "stream")]);
    const { cols, pending } = holdFrame(frame, fresh, new Map());
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models.map((c) => c.id)).toEqual(["c1"]);
    expect(cols.graduated).toEqual([]);
    // m0 is new in two columns but one alert; g1 is new.
    expect(pending).toBe(2);
  });

  it("keeps a row whose alert left the feed, from its last card", () => {
    const gone = card("m1", "match");
    const frame = frameOf(splitScope([gone], []));
    const { cols } = holdFrame(frame, splitScope([], []), new Map([["m1", gone]]));
    expect(cols.filters).toEqual([gone]);
  });
});

describe("scopeTickIds", () => {
  it("takes each column's top rows in turn, within the tick's limit", () => {
    const filters = Array.from({ length: 20 }, (_, i) => card(`m${i}`, "match"));
    const models = Array.from({ length: 20 }, (_, i) => card(`c${i}`, "curated", true));
    const ids = scopeTickIds({ filters, models, graduated: [card("g0", "stream")] });
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
