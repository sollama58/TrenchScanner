import { describe, expect, it } from "vitest";
import { matchesFilter } from "./matchFilters.js";
import { EMPTY_TRADE_FLOW } from "../curation/tradeFlow.js";
import type { NarrativeRead } from "../curation/narrativeFeatures.js";
import type { FilterCriteria, ScoredToken } from "../types.js";

function baseToken(overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.001,
    marketCapUsd: 200_000,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 70, holderHealth: 70, age: 70, narrative: 70, total: 70 },
    ...overrides,
  };
}

const baseFilter: FilterCriteria = { mcapMin: 50_000, mcapMax: 500_000 };

describe("matchesFilter", () => {
  it("matches a token within the mcap band with no extra criteria", () => {
    expect(matchesFilter(baseToken(), baseFilter)).toBe(true);
  });

  it("rejects a token outside the mcap band", () => {
    expect(matchesFilter(baseToken({ marketCapUsd: 10_000 }), baseFilter)).toBe(false);
    expect(matchesFilter(baseToken({ marketCapUsd: 1_000_000 }), baseFilter)).toBe(false);
  });

  it("applies minVolumeMcapRatio", () => {
    const filter = { ...baseFilter, minVolumeMcapRatio: 1 };
    expect(matchesFilter(baseToken({ volumeToMcapRatio: 0.5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ volumeToMcapRatio: 1.5 }), filter)).toBe(true);
  });

  it("applies minHolderGrowthPct", () => {
    const filter = { ...baseFilter, minHolderGrowthPct: 10 };
    expect(matchesFilter(baseToken({ holderGrowthPct: 5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ holderGrowthPct: 20 }), filter)).toBe(true);
  });

  it("applies maxTop10HolderPct only when known", () => {
    const filter = { ...baseFilter, maxTop10HolderPct: 30 };
    expect(matchesFilter(baseToken({ top10HolderPct: 50 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ top10HolderPct: 20 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ top10HolderPct: undefined }), filter)).toBe(true);
  });

  it("applies maxDevWalletPct only when known", () => {
    const filter = { ...baseFilter, maxDevWalletPct: 10 };
    expect(matchesFilter(baseToken({ devWalletPct: 25 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ devWalletPct: 5 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ devWalletPct: undefined }), filter)).toBe(true);
  });

  it("applies maxRiskScore only when known", () => {
    const filter = { ...baseFilter, maxRiskScore: 50 };
    expect(matchesFilter(baseToken({ riskScore: 80 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ riskScore: 20 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ riskScore: undefined }), filter)).toBe(true);
  });

  it("applies excludeCriticalRiskFlags", () => {
    const filter = { ...baseFilter, excludeCriticalRiskFlags: true };
    expect(matchesFilter(baseToken({ riskFlags: ["Creator history of rugged tokens"] }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ riskFlags: ["Creator identity unknown"] }), filter)).toBe(false);
    // A non-critical flag doesn't trip this - only the named critical set does.
    expect(matchesFilter(baseToken({ riskFlags: ["High holder correlation"] }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ riskFlags: [] }), filter)).toBe(true);
  });

  it("does not exclude critical risk flags when the user hasn't opted in", () => {
    expect(matchesFilter(baseToken({ riskFlags: ["Creator history of rugged tokens"] }), baseFilter)).toBe(
      true,
    );
  });

  it("applies maxFreshTop10WalletPct only when known", () => {
    const filter = { ...baseFilter, maxFreshTop10WalletPct: 20 };
    expect(matchesFilter(baseToken({ freshTop10WalletPct: 50 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ freshTop10WalletPct: 10 }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ freshTop10WalletPct: undefined }), filter)).toBe(true);
  });

  it("applies min/max token age", () => {
    const filter = { ...baseFilter, minTokenAgeMinutes: 30, maxTokenAgeMinutes: 720 };
    expect(matchesFilter(baseToken({ ageMinutes: 5 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ ageMinutes: 1000 }), filter)).toBe(false);
    expect(matchesFilter(baseToken({ ageMinutes: 100 }), filter)).toBe(true);
  });

  it("applies narrative keywords against name/symbol/tags", () => {
    const filter = { ...baseFilter, narrativeKeywords: ["moon"] };
    expect(matchesFilter(baseToken({ name: "Moon Dog" }), filter)).toBe(true);
    expect(matchesFilter(baseToken({ name: "Sun Cat" }), filter)).toBe(false);
  });

  it("applies minScore", () => {
    const filter = { ...baseFilter, minScore: 80 };
    expect(
      matchesFilter(
        baseToken({ score: { momentum: 50, holderHealth: 50, age: 50, narrative: 50, total: 50 } }),
        filter,
      ),
    ).toBe(false);
    expect(
      matchesFilter(
        baseToken({ score: { momentum: 90, holderHealth: 90, age: 90, narrative: 90, total: 90 } }),
        filter,
      ),
    ).toBe(true);
  });
});

describe("maxEmptyTop10WalletPct", () => {
  it("rejects a token whose top-10 are mostly wallets holding nothing else", () => {
    const token = baseToken({ emptyTop10WalletPct: 80 });
    expect(matchesFilter(token, { ...baseFilter, maxEmptyTop10WalletPct: 50 })).toBe(false);
  });

  it("accepts one whose holders are real traders", () => {
    const token = baseToken({ emptyTop10WalletPct: 10 });
    expect(matchesFilter(token, { ...baseFilter, maxEmptyTop10WalletPct: 50 })).toBe(true);
  });

  it("does not reject when the signal was never resolved", () => {
    // Unknown skips, like every other risk cap: a lookup the per-cycle budget deferred - or an
    // endpoint that cannot serve DAS at all - must not silently filter out every token.
    const token = baseToken({ emptyTop10WalletPct: undefined });
    expect(matchesFilter(token, { ...baseFilter, maxEmptyTop10WalletPct: 0 })).toBe(true);
  });

  it("is inert when the user has not set it", () => {
    const token = baseToken({ emptyTop10WalletPct: 100 });
    expect(matchesFilter(token, baseFilter)).toBe(true);
  });
});

describe("first buyers still holding", () => {
  const withHolding = (n: number | null) =>
    baseToken({
      tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersHolding: n, firstBuyersSeen: n === null ? null : 25 },
    });

  it("applies the floor and the ceiling", () => {
    expect(matchesFilter(withHolding(8), { ...baseFilter, minFirstBuyersHolding: 10 })).toBe(false);
    expect(matchesFilter(withHolding(12), { ...baseFilter, minFirstBuyersHolding: 10 })).toBe(true);
    expect(matchesFilter(withHolding(20), { ...baseFilter, maxFirstBuyersHolding: 15 })).toBe(false);
    expect(matchesFilter(withHolding(15), { ...baseFilter, maxFirstBuyersHolding: 15 })).toBe(true);
  });

  it("fails the floor but skips the ceiling when the launch wasn't seen", () => {
    expect(matchesFilter(withHolding(null), { ...baseFilter, minFirstBuyersHolding: 10 })).toBe(false);
    expect(matchesFilter(withHolding(null), { ...baseFilter, maxFirstBuyersHolding: 15 })).toBe(true);
  });
});

describe("TokenSage narrative criteria", () => {
  const read = (overrides: Partial<NarrativeRead> = {}): NarrativeRead => ({
    depth: "basic",
    status: "complete",
    analyzedAt: null,
    categories: [
      { label: "animal", confidence: 0.9 },
      { label: "animal/dog", confidence: 0.9 },
      { label: "derivative", confidence: 0.3 },
    ],
    referentLabel: null,
    referentKind: null,
    referentConfidence: null,
    referentSupport: [],
    flags: [],
    highFlagCount: 0,
    warnFlagCount: 0,
    copiesRecent: false,
    xFit: null,
    xVerdict: null,
    xRelation: null,
    xAuthorFollowers: null,
    xPredatesTokenS: null,
    xReuseCount: null,
    trendMatched: null,
    lineageKind: null,
    lineageRank: null,
    lineageRankOf: null,
    lineageOfMint: null,
    originalAgeS: null,
    originalCurveProgress: null,
    originalComplete: null,
    siblings1h: null,
    siblings6h: null,
    siblings24h: null,
    logoReuse24h: null,
    waveLaunches1h: null,
    waveLaunches6h: null,
    waveLaunches24h: null,
    waveRank24h: null,
    topCategoryInputs: null,
    xCredibility: null,
    xAccountAgeS: null,
    xAccountMadeForCoin: null,
    xReuseRank: null,
    trendScore: null,
    ...overrides,
  });

  it("is inert when the filter sets none of them, read or no read", () => {
    expect(matchesFilter(baseToken(), baseFilter)).toBe(true);
    expect(
      matchesFilter(baseToken({ narrative: read({ copiesRecent: true, highFlagCount: 2 }) }), baseFilter),
    ).toBe(true);
  });

  it("fails closed without a read, whichever criterion is set", () => {
    for (const filter of [
      { ...baseFilter, narrativeCategories: ["animal"] },
      { ...baseFilter, excludeNarrativeCategories: ["political"] },
      { ...baseFilter, excludeCopycats: true },
      { ...baseFilter, excludeNarrativeRedFlags: true },
      { ...baseFilter, excludeUnrelatedX: true },
      { ...baseFilter, requireTrendMatch: true },
      { ...baseFilter, excludeLateCopies: true },
    ]) {
      expect(matchesFilter(baseToken(), filter)).toBe(false);
    }
  });

  it("matches themes by top-level id or full label, at the confidence floor", () => {
    const token = baseToken({ narrative: read() });
    expect(matchesFilter(token, { ...baseFilter, narrativeCategories: ["animal"] })).toBe(true);
    expect(matchesFilter(token, { ...baseFilter, narrativeCategories: ["animal/dog"] })).toBe(true);
    expect(matchesFilter(token, { ...baseFilter, narrativeCategories: ["animal/cat"] })).toBe(false);
    expect(matchesFilter(token, { ...baseFilter, narrativeCategories: ["political", "animal"] })).toBe(true);
    // Below the floor, "derivative" does not count, for or against.
    expect(matchesFilter(token, { ...baseFilter, narrativeCategories: ["derivative"] })).toBe(false);
    expect(matchesFilter(token, { ...baseFilter, excludeNarrativeCategories: ["derivative"] })).toBe(true);
    expect(matchesFilter(token, { ...baseFilter, excludeNarrativeCategories: ["animal"] })).toBe(false);
  });

  it("skips copycats, reused names and red flags", () => {
    const f = { ...baseFilter, excludeCopycats: true, excludeNarrativeRedFlags: true };
    expect(matchesFilter(baseToken({ narrative: read() }), f)).toBe(true);
    expect(matchesFilter(baseToken({ narrative: read({ copiesRecent: true }) }), f)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ flags: ["earlier_same_name"] }) }), f)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ highFlagCount: 1 }) }), f)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ warnFlagCount: 3 }) }), f)).toBe(true);
  });

  it("skips late copies, and fails closed on a read that predates lineage", () => {
    const f = { ...baseFilter, excludeLateCopies: true };
    expect(matchesFilter(baseToken({ narrative: read() }), f)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ lineageKind: "original" }) }), f)).toBe(true);
    expect(
      matchesFilter(baseToken({ narrative: read({ lineageKind: "early_copy", copiesRecent: true }) }), f),
    ).toBe(true);
    expect(matchesFilter(baseToken({ narrative: read({ lineageKind: "late_copy" }) }), f)).toBe(false);
    // TokenSage could not place the coin: not checkable, so the exclusion fails closed.
    expect(matchesFilter(baseToken({ narrative: read({ lineageKind: "unknown" }) }), f)).toBe(false);
    expect(
      matchesFilter(baseToken({ narrative: read({ lineageKind: "copy", flags: ["late_copy"] }) }), f),
    ).toBe(false);
  });

  it("needs the deep read for the X post and the trend", () => {
    const x = { ...baseFilter, excludeUnrelatedX: true };
    expect(matchesFilter(baseToken({ narrative: read() }), x)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read(), hasTwitter: true }), x)).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ depth: "full" }) }), x)).toBe(true);
    expect(matchesFilter(baseToken({ narrative: read({ depth: "full", xVerdict: "unrelated" }) }), x)).toBe(
      false,
    );
    expect(matchesFilter(baseToken({ narrative: read({ depth: "full", xRelation: "spoofed" }) }), x)).toBe(
      false,
    );
    const trend = { ...baseFilter, requireTrendMatch: true };
    expect(matchesFilter(baseToken({ narrative: read({ trendMatched: true }) }), trend)).toBe(false);
    // No X link: nothing for the deep read to open, so the trend still needs it...
    expect(
      matchesFilter(baseToken({ narrative: read({ trendMatched: true }), hasTwitter: false }), trend),
    ).toBe(false);
    expect(matchesFilter(baseToken({ narrative: read({ depth: "full", trendMatched: true }) }), trend)).toBe(
      true,
    );
    expect(matchesFilter(baseToken({ narrative: read({ depth: "full", trendMatched: false }) }), trend)).toBe(
      false,
    );
  });

  it("passes 'exclude unrelated X' on a basic read when the coin has no X link", () => {
    const x = { ...baseFilter, excludeUnrelatedX: true };
    // ...but a coin without a link has no X post to be unrelated: the basic read is enough.
    expect(matchesFilter(baseToken({ narrative: read(), hasTwitter: false }), x)).toBe(true);
    // An unknown flag fails closed like the rest.
    expect(matchesFilter(baseToken({ narrative: read(), hasTwitter: undefined }), x)).toBe(false);
    // Still no read, no match.
    expect(matchesFilter(baseToken({ hasTwitter: false }), x)).toBe(false);
    // A full read keeps judging the post, link or not.
    expect(
      matchesFilter(
        baseToken({ narrative: read({ depth: "full", xVerdict: "unrelated" }), hasTwitter: false }),
        x,
      ),
    ).toBe(false);
  });
});
