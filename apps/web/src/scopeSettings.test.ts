import { describe, expect, it } from "vitest";
import type { Card } from "./api";
import {
  activeFilterCount,
  DEFAULT_COLUMN_FILTER,
  DEFAULT_SCOPE_SETTINGS,
  normalizeScopeSettings,
  passesColumnFilter,
  scopeHideSet,
  type ScopeColumnFilter,
} from "./scopeSettings";

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

  it("narrows the Models column by tier and model", () => {
    expect(passesColumnFilter(card({ model: "Atlas" }), f({ highOnly: true }), "models", NOW)).toBe(false);
    expect(
      passesColumnFilter(card({ model: "Atlas", tier: "high" }), f({ highOnly: true }), "models", NOW),
    ).toBe(true);
    expect(passesColumnFilter(card({ model: "Atlas" }), f({ models: ["Orion"] }), "models", NOW)).toBe(false);
    expect(passesColumnFilter(card({ model: "Orion" }), f({ models: ["Orion"] }), "models", NOW)).toBe(true);
  });

  it("narrows Your filters to the picked filters", () => {
    expect(passesColumnFilter(card({ filter: "Main" }), f({ filters: ["Fast"] }), "filters", NOW)).toBe(
      false,
    );
    expect(passesColumnFilter(card({ filter: "Fast" }), f({ filters: ["Fast"] }), "filters", NOW)).toBe(true);
  });
});

describe("normalizeScopeSettings", () => {
  it("falls back to the defaults for missing or broken fields", () => {
    expect(normalizeScopeSettings(null)).toEqual(DEFAULT_SCOPE_SETTINGS);
    const s = normalizeScopeSettings({
      display: { compact: "yes", chips: ["top10", "nope"] },
      columns: { models: { mcapMin: -5, maxAgeMin: 30, socials: "weird", models: ["Atlas", 3] } },
    });
    expect(s.display.compact).toBe(false);
    expect(s.display.chips).toEqual(["top10"]);
    expect(s.columns.models).toMatchObject({
      mcapMin: null,
      maxAgeMin: 30,
      socials: "any",
      models: ["Atlas"],
    });
  });

  it("never hides every column", () => {
    const s = normalizeScopeSettings({ display: { hiddenColumns: ["filters", "models", "graduated"] } });
    expect(s.display.hiddenColumns).toHaveLength(2);
  });
});

describe("activeFilterCount and scopeHideSet", () => {
  it("counts the filters that are on", () => {
    expect(activeFilterCount(DEFAULT_COLUMN_FILTER)).toBe(0);
    expect(activeFilterCount(f({ mcapMin: 1, socials: "x", models: ["A"] }))).toBe(3);
  });

  it("turns display toggles into the row's hidden fields", () => {
    const hide = scopeHideSet({ ...DEFAULT_SCOPE_SETTINGS.display, showAt: false, chips: ["top10"] });
    expect(hide.has("alert")).toBe(true);
    expect(hide.has("top10")).toBe(false);
    expect(hide.has("holders")).toBe(true);
  });
});
