import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import { frameOf, holdFrame, scopeTickIds, shortAge, splitScope } from "./scope";

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

describe("splitScope", () => {
  it("puts filter alerts, model calls and graduated tokens in their columns, keeping order", () => {
    const feed = [card("m1", "match"), card("c1", "curated", true), card("m2", "match")];
    const cols = splitScope(feed, [card("g1", "stream")]);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(cols.models.map((c) => c.id)).toEqual(["c1"]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
  });

  it("shows a token a filter and a model both alerted on only in the column that alerted first", () => {
    const both = (matchedAt: string, alertedAt: string) =>
      ({ ...card("m1", "match"), matchedAt, curated: { alertId: "a", alertedAt } }) as Card;
    let cols = splitScope([both("2026-10-19T01:00:00Z", "2026-10-19T01:05:00Z")], []);
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models).toEqual([]);
    cols = splitScope([both("2026-10-19T01:05:00Z", "2026-10-19T01:00:00Z")], []);
    expect(cols.filters).toEqual([]);
    expect(cols.models.map((c) => c.id)).toEqual(["m1"]);
    // Separate cards for one token: the model's call came first, so the filter's alert stays out.
    const filterAlert = { ...card("m2", "match", false, "t-x"), matchedAt: "2026-10-19T01:05:00Z" } as Card;
    const modelCall = {
      ...card("c2", "curated", false, "t-x"),
      matchedAt: "2026-10-19T01:00:00Z",
      curated: { alertId: "c2", alertedAt: "2026-10-19T01:00:00Z" },
    } as Card;
    cols = splitScope([filterAlert, modelCall], []);
    expect(cols.filters).toEqual([]);
    expect(cols.models.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("graduated alerts", () => {
  const grad = (c: Card): Card => ({ ...c, snapshot: { graduated: true }, latestSnapshot: null }) as Card;
  const at = (c: Card, iso: string): Card => ({ ...c, matchedAt: iso }) as Card;

  it("moves an alert whose coin graduated to the Graduated column, in its coin's place", () => {
    const alert = at(card("m1", "match", true, "tok"), "2026-10-18T10:00:00Z");
    const entry = at(card("g1", "stream", false, "tok"), "2026-10-18T11:00:00Z");
    const other = at(card("g2", "stream"), "2026-10-18T12:00:00Z");
    const cols = splitScope([alert], [other, entry]);
    expect(cols.filters).toEqual([]);
    expect(cols.models).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g2", "m1"]);
  });

  it("moves one its own scans call graduated, by its alert time", () => {
    const alert = grad(at(card("m1", "match"), "2026-10-18T11:30:00Z"));
    const older = at(card("g1", "stream"), "2026-10-18T11:00:00Z");
    const cols = splitScope([alert, at(card("m2", "match"), "2026-10-18T11:40:00Z")], [older]);
    expect(cols.filters.map((c) => c.id)).toEqual(["m2"]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["m1", "g1"]);
  });

  it("keeps it in its own column too when the column shows graduated alerts", () => {
    const alert = grad(at(card("m1", "match", true), "2026-10-18T11:30:00Z"));
    const cols = splitScope([alert], [], { filters: true, models: false });
    expect(cols.filters.map((c) => c.id)).toEqual(["m1"]);
    expect(cols.models).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["m1"]);
  });
});

describe("the Stream's columns", () => {
  const priced = (c: Card, mcap: number): Card =>
    ({ ...c, snapshot: { marketCapUsd: mcap }, currentMarketCapUsd: null }) as Card;

  it("puts tokens near graduating in About to graduate, closest first, the rest in New", () => {
    const stream = [
      priced(card("s1", "stream"), 12_000),
      priced(card("s2", "stream"), 50_000),
      priced(card("s3", "stream"), 61_000),
    ];
    const cols = splitScope([], [], undefined, stream);
    expect(cols.new.map((c) => c.id)).toEqual(["s1"]);
    expect(cols.soon.map((c) => c.id)).toEqual(["s3", "s2"]);
  });

  it("leaves a graduated token to the Graduated column", () => {
    const entry = card("g1", "stream", false, "tok");
    const cols = splitScope([], [entry], undefined, [priced(card("s1", "stream", false, "tok"), 80_000)]);
    expect(cols.new).toEqual([]);
    expect(cols.soon).toEqual([]);
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
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
    // Graduated was empty when paused (not loaded yet): it fills in rather than waiting.
    expect(cols.graduated.map((c) => c.id)).toEqual(["g1"]);
    // m0 is new in two columns but one alert.
    expect(pending).toBe(1);
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

describe("About to graduate", () => {
  const at = (id: string, mcap: number) =>
    ({ ...card(id, "stream"), currentMarketCapUsd: mcap, snapshot: { marketCapUsd: 20_000 } }) as Card;

  it("takes the Stream's about-to-graduate list, still at the mark, biggest first", () => {
    const cols = splitScope(
      [],
      [],
      undefined,
      [at("n1", 12_000)],
      [at("s1", 50_000), at("s2", 80_000), at("s3", 30_000)],
    );
    expect(cols.soon.map((c) => c.id)).toEqual(["s2", "s1"]);
    // One that dropped under the mark since isn't new: it goes nowhere.
    expect(cols.new.map((c) => c.id)).toEqual(["n1"]);
  });
});
