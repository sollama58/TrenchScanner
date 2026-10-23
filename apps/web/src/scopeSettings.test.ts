import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import {
  activeFilterCount,
  DEFAULT_COLUMN_FILTER,
  DEFAULT_SCOPE_SETTINGS,
  normalizeScopeSettings,
  passesColumnFilter,
  withinMaxAge,
  type ScopeColumnFilter,
} from "./scopeSettings";
import { rowChips } from "./scopeChips";

const NOW = Date.parse("2026-10-18T18:00:00Z");

/** A card with just what the filters read. */
function card(over: {
  mcap?: number;
  minutesAgo?: number;
  holders?: number | null;
  top10?: number | null;
  twitter?: string | null;
  tier?: string | null;
  model?: string;
  filter?: string;
  kind?: Card["kind"];
}): Card {
  const at = new Date(NOW - (over.minutesAgo ?? 1) * 60_000).toISOString();
  const kind = over.kind ?? (over.model ? "curated" : "match");
  return {
    id: "c",
    kind,
    tokenId: "t",
    matchedAt: at,
    score: 0,
    peakReturnPct: null,
    token: {
      id: "t",
      mintAddress: "m",
      symbol: "X",
      name: null,
      imageUrl: null,
      twitterUrl: over.twitter ?? null,
      websiteUrl: null,
    },
    snapshot: {
      takenAt: at,
      marketCapUsd: over.mcap ?? 20_000,
      holderCount: over.holders ?? null,
      top10HolderPct: over.top10 ?? null,
    } as Card["snapshot"],
    latestSnapshot: null,
    currentMarketCapUsd: null,
    filter: over.filter ? { id: "f", name: over.filter } : null,
    curated: over.model
      ? ({
          alertId: "a",
          source: "model",
          modelName: over.model,
          tier: over.tier ?? null,
          confidence: 80,
          reasons: [],
          alertedAt: at,
          outcome: { status: "watching", hit2x: false, minutesLeft: 10 },
        } as unknown as Card["curated"])
      : null,
  } as Card;
}

const f = (over: Partial<ScopeColumnFilter>): ScopeColumnFilter => ({ ...DEFAULT_COLUMN_FILTER, ...over });

describe("passesColumnFilter", () => {
  it("lets everything through with no filters on", () => {
    expect(passesColumnFilter(card({}), DEFAULT_COLUMN_FILTER, "filters", NOW)).toBe(true);
  });

  it("bounds the market cap and the age", () => {
    expect(passesColumnFilter(card({ mcap: 9_000 }), f({ mcapMin: 10_000 }), "filters", NOW)).toBe(false);
    expect(passesColumnFilter(card({ mcap: 90_000 }), f({ mcapMax: 50_000 }), "filters", NOW)).toBe(false);
    expect(passesColumnFilter(card({ minutesAgo: 30 }), f({ maxAgeMin: 15 }), "filters", NOW)).toBe(false);
    expect(passesColumnFilter(card({ minutesAgo: 5 }), f({ maxAgeMin: 15 }), "filters", NOW)).toBe(true);
  });

  it("keeps the age cutoff on its own, for coins the wallet holds", () => {
    const g = f({ maxAgeMin: 15, mcapMin: 10_000 });
    expect(withinMaxAge(card({ minutesAgo: 5, mcap: 1_000 }), g, NOW)).toBe(true);
    expect(withinMaxAge(card({ minutesAgo: 30, mcap: 90_000 }), g, NOW)).toBe(false);
    expect(withinMaxAge(card({ minutesAgo: 600 }), DEFAULT_COLUMN_FILTER, NOW)).toBe(true);
  });

  it("judges only readings the card has", () => {
    expect(passesColumnFilter(card({ holders: 50 }), f({ minHolders: 100 }), "filters", NOW)).toBe(false);
    expect(passesColumnFilter(card({ holders: null }), f({ minHolders: 100 }), "filters", NOW)).toBe(true);
    expect(passesColumnFilter(card({ top10: 35 }), f({ maxTop10Pct: 30 }), "filters", NOW)).toBe(false);
  });

  it("asks for the coin's links", () => {
    expect(passesColumnFilter(card({}), f({ socials: "x" }), "filters", NOW)).toBe(false);
    expect(
      passesColumnFilter(card({ twitter: "https://x.com/a" }), f({ socials: "either" }), "filters", NOW),
    ).toBe(true);
    expect(
      passesColumnFilter(card({ twitter: "https://x.com/a" }), f({ socials: "both" }), "filters", NOW),
    ).toBe(false);
  });

  it("narrows model columns to high-conviction calls", () => {
    expect(passesColumnFilter(card({ model: "Atlas" }), f({ highOnly: true }), "models", NOW)).toBe(false);
    expect(
      passesColumnFilter(card({ model: "Atlas", tier: "high" }), f({ highOnly: true }), "model", NOW),
    ).toBe(true);
    // Not a filter's alerts: high conviction is about model calls.
    expect(passesColumnFilter(card({}), f({ highOnly: true }), "filters", NOW)).toBe(true);
  });
});

describe("normalizeScopeSettings", () => {
  it("falls back to the defaults for missing or broken fields", () => {
    expect(normalizeScopeSettings(null)).toEqual(DEFAULT_SCOPE_SETTINGS);
    const s = normalizeScopeSettings({
      display: { density: "huge", chips: ["top10", "nope"] },
      columns: { models: { mcapMin: -5, maxAgeMin: 30, socials: "weird", models: ["Atlas", 3] } },
    });
    expect(s.display.density).toBe("roomy");
    expect(s.display.chips).toEqual(["top10"]);
    expect(s.board.map((c) => c.kind)).toEqual(["filters", "models", "graduated"]);
    expect(s.board[1]!.filter).toMatchObject({ mcapMin: null, maxAgeMin: 30, socials: "any" });
  });

  it("turns an old Stream board into New, About to graduate and Graduated, less the hidden ones", () => {
    const s = normalizeScopeSettings({
      display: { hiddenColumns: ["new", "soon", "graduated"], stream: true },
      columns: { soon: { minHolders: 20 } },
    });
    expect(s.board.map((c) => c.id)).toEqual(["graduated"]);
    const t = normalizeScopeSettings({
      display: { hiddenColumns: ["new"], stream: true },
      columns: { soon: { minHolders: 20 } },
    });
    expect(t.board.map((c) => c.kind)).toEqual(["soon", "graduated"]);
    expect(t.board[0]!.filter.minHolders).toBe(20);
  });

  it("keeps a saved board within six columns, three picks, known kinds and unique ids", () => {
    const col = (id: unknown, kind: unknown, picks: unknown = []) => ({ id, kind, picks, filter: {} });
    const s = normalizeScopeSettings({
      display: {},
      board: [
        col("a", "model", ["m1", "m2", "m3", "m4"]),
        col("a", "new", ["x"]),
        col("b", "nope"),
        col("bad id!", "graduated"),
        col("c", "filters"),
        col("d", "soon"),
        col("e", "filter", ["f1", "f1"]),
        col("f", "models"),
      ],
    });
    expect(s.board).toHaveLength(6);
    expect(s.board[0]!.picks).toEqual(["m1", "m2", "m3"]);
    expect(s.board[1]).toMatchObject({ id: "new", kind: "new", picks: [] });
    expect(s.board[2]).toMatchObject({ id: "graduated", kind: "graduated" });
    expect(s.board[5]).toMatchObject({ kind: "filter", picks: ["f1"] });
    expect(new Set(s.board.map((c) => c.id)).size).toBe(6);
  });

  it("never keeps an empty board", () => {
    expect(normalizeScopeSettings({ display: {}, board: [] }).board).toEqual(DEFAULT_SCOPE_SETTINGS.board);
  });
});

describe("activeFilterCount", () => {
  it("counts the filters that are on", () => {
    expect(activeFilterCount(DEFAULT_COLUMN_FILTER)).toBe(0);
    expect(activeFilterCount(f({ mcapMin: 1, socials: "x", highOnly: true }))).toBe(3);
  });

  it("reads an old saved compact setting as compact density", () => {
    expect(normalizeScopeSettings({ display: { compact: true } }).display.density).toBe("compact");
  });
});

describe("rowChips", () => {
  it("shows the picked chips the card has readings for, in the window's order", () => {
    const chips = rowChips(card({ holders: 120, top10: 22 }), ["top10", "holders", "vol5m"]);
    expect(chips.map((c) => c.id)).toEqual(["holders", "top10"]);
    expect(chips[0]?.value).toBe("120");
  });

  it("reads the contract check and flagged traders, red when something's wrong", () => {
    const c = card({});
    Object.assign(c.snapshot, {
      mintAuthorityActive: false,
      freezeAuthorityActive: true,
      lpBurned: true,
      flaggedBuyers: 2,
      flaggedSellers: 0,
    });
    const chips = rowChips(c, ["flagged", "contract"], NOW);
    expect(chips.map((x) => [x.id, x.value, x.risky])).toEqual([
      ["flagged", "2B 0S", true],
      ["contract", "Freeze", true],
    ]);
    Object.assign(c.snapshot, { freezeAuthorityActive: false });
    expect(rowChips(c, ["contract"], NOW)[0]).toMatchObject({ value: "OK", risky: false });
  });

  it("reads the card's conviction", () => {
    const chips = rowChips(card({ model: "Atlas", tier: "high" }), ["conviction"], NOW);
    expect(chips.map((x) => [x.id, x.value])).toEqual([["conviction", "high"]]);
  });
});
