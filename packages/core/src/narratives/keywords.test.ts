import { describe, expect, it } from "vitest";
import { extractNarrativeTags, matchesNarrativeKeywords } from "./keywords.js";

describe("extractNarrativeTags", () => {
  it("tags a dog-themed token", () => {
    expect(extractNarrativeTags({ name: "Doge Classic", symbol: "DOGE" })).toContain("dog");
  });

  it("tags multiple matching narratives", () => {
    const tags = extractNarrativeTags({ name: "AI Pepe Agent", description: "based ai agent" });
    expect(tags).toEqual(expect.arrayContaining(["ai", "frog", "based"]));
  });

  it("returns no tags for generic text", () => {
    expect(extractNarrativeTags({ name: "Random Token", symbol: "RND" })).toEqual([]);
  });

  it("does not false-positive on substrings (word boundary check)", () => {
    // "catalog" contains "cat" as a substring but isn't cat-themed.
    expect(extractNarrativeTags({ name: "Catalog Token", symbol: "CTLG" })).not.toContain("cat");
  });
});

describe("matchesNarrativeKeywords", () => {
  const token = { name: "Moon Dog", symbol: "MDOG", narrativeTags: ["dog"] };

  it("matches with no keywords configured", () => {
    expect(matchesNarrativeKeywords(token, undefined)).toBe(true);
    expect(matchesNarrativeKeywords(token, [])).toBe(true);
  });

  it("matches when a keyword appears in the name", () => {
    expect(matchesNarrativeKeywords(token, ["moon"])).toBe(true);
  });

  it("matches when a keyword appears in narrative tags", () => {
    expect(matchesNarrativeKeywords(token, ["dog"])).toBe(true);
  });

  it("rejects when no keyword matches", () => {
    expect(matchesNarrativeKeywords(token, ["cat", "frog"])).toBe(false);
  });
});
