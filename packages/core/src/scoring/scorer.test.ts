import { describe, expect, it } from "vitest";
import {
  LATE_COPY_PENALTY,
  NARRATIVE_NEUTRAL,
  NARRATIVE_RED_FLAG_CAP,
  X_POST_PREDATES_MIN_S,
  scoreNarrative,
  scoreToken,
  scoreTokenLegacy,
} from "./scorer.js";
import type { NarrativeRead } from "../curation/narrativeFeatures.js";
import type { EnrichedToken } from "../types.js";
import { EMPTY_TRADE_FLOW } from "../curation/tradeFlow.js";

function baseToken(overrides: Partial<EnrichedToken> = {}): EnrichedToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.001,
    marketCapUsd: 20_000,
    narrativeTags: [],
    ...overrides,
  };
}

describe("scoreToken", () => {
  it("scores a fresh launch with a hot 5-minute window highly", () => {
    const score = scoreToken(
      baseToken({
        ageMinutes: 2,
        graduated: false,
        priceChange5mPct: 60,
        volume5mUsd: 25_000,
        buys5m: 300,
        sells5m: 100,
        top10HolderPct: 25,
        emptyTop10WalletPct: 10,
        tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersHolding: 20 },
      }),
    );
    expect(score.total).toBeGreaterThan(85);
  });

  it("scores an old, fading token low", () => {
    const score = scoreToken(
      baseToken({
        ageMinutes: 3000,
        graduated: true,
        priceChange5mPct: -8,
        volume5mUsd: 200,
        buys5m: 10,
        sells5m: 30,
        emptyTop10WalletPct: 60,
      }),
    );
    expect(score.total).toBeLessThan(25);
  });

  it("ranks younger above older, all else equal", () => {
    const young = scoreToken(baseToken({ ageMinutes: 3 }));
    const old = scoreToken(baseToken({ ageMinutes: 120 }));
    expect(young.total).toBeGreaterThan(old.total);
    expect(young.age).toBe(100);
  });

  it("zeroes holder quality for a pre-bond launch with a thin top 10", () => {
    expect(scoreToken(baseToken({ graduated: false, top10HolderPct: 12 })).holderHealth).toBe(0);
    expect(scoreToken(baseToken({ graduated: true, top10HolderPct: 12 })).holderHealth).toBe(50);
    expect(scoreToken(baseToken({ graduated: false, top10HolderPct: 25 })).holderHealth).toBe(50);
  });

  it("lets unknown momentum pieces abstain instead of counting as zero", () => {
    expect(scoreToken(baseToken()).momentum).toBe(50);
    // Only the price move known: it alone sets the part.
    expect(scoreToken(baseToken({ priceChange5mPct: 40 })).momentum).toBe(100);
    // 5m buys missing, falls back to the hour's.
    expect(scoreToken(baseToken({ buys1h: 75, sells1h: 25 })).momentum).toBe(100);
  });

  it("holds narrative neutral until TokenSage feeds it", () => {
    const tagged = scoreToken(baseToken({ narrativeTags: ["dog"], hasTwitter: true, hasWebsite: true }));
    expect(tagged.narrative).toBe(NARRATIVE_NEUTRAL);
    expect(tagged.total).toBe(scoreToken(baseToken()).total);
  });

  it("stays within 0-100 bounds", () => {
    const score = scoreToken(
      baseToken({ priceChange5mPct: 5000, volume5mUsd: 1e9, holderGrowth10mPct: 9999, ageMinutes: 0 }),
    );
    for (const value of Object.values(score)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("scoreTokenLegacy", () => {
  it("keeps the first composite's numbers for the stored model inputs", () => {
    const token = baseToken({
      volumeToMcapRatio: 2.5,
      buys24h: 800,
      sells24h: 200,
      holderGrowthPct: 25,
      top10HolderPct: 15,
      ageMinutes: 120,
      hasTwitter: true,
      hasTelegram: true,
      hasWebsite: true,
      narrativeTags: ["dog"],
    });
    const score = scoreTokenLegacy(token);
    expect(score.momentum).toBe(92);
    expect(score.holderHealth).toBe(87.5);
    expect(score.age).toBe(100);
    expect(score.narrative).toBe(100);
    expect(score.total).toBeCloseTo(92 * 0.35 + 87.5 * 0.3 + 15 + 20, 6);
    expect(scoreTokenLegacy(baseToken({ ageMinutes: undefined })).age).toBe(50);
  });
});

function read(overrides: Partial<NarrativeRead> = {}): NarrativeRead {
  return {
    depth: "basic",
    status: "complete",
    analyzedAt: null,
    categories: [],
    referentLabel: null,
    referentKind: null,
    referentConfidence: null,
    referentSupport: [],
    referentGeneric: null,
    flags: [],
    highFlagCount: 0,
    warnFlagCount: 0,
    copiesRecent: null,
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
  };
}

describe("scoreNarrative", () => {
  it("is the midpoint without a read, and a bare X link earns nothing", () => {
    expect(scoreNarrative(baseToken())).toBe(NARRATIVE_NEUTRAL);
    expect(scoreNarrative(baseToken({ hasTwitter: true, narrativeTags: ["dog"] }))).toBe(NARRATIVE_NEUTRAL);
    expect(scoreNarrative(baseToken({ narrative: read() }))).toBe(NARRATIVE_NEUTRAL);
  });

  it("credits a named referent, more when inputs agree, and half as much for a kind alone", () => {
    // TokenSage's bands (rules 0.17.0): 0.5-0.69 one input, 0.7+ two or more agreeing.
    const named = (referentConfidence: number, referentSupport: string[], referentGeneric = false) =>
      scoreNarrative(
        baseToken({ narrative: read({ referentConfidence, referentSupport, referentGeneric }) }),
      );
    expect(named(0.63, ["name"])).toBe(60);
    expect(named(0.7, ["name"])).toBe(65);
    expect(named(0.55, ["name", "x"])).toBe(65);
    expect(named(0.97, ["name", "description"])).toBe(65);
    expect(named(0.4, ["name"])).toBe(NARRATIVE_NEUTRAL);
    // FROGMAN: a frog coin, generic at 0.38 - and a generic read at 0.6 is still a kind, not a story.
    expect(named(0.38, ["name"], true)).toBe(55);
    expect(named(0.6, ["name", "image"], true)).toBe(55);
    expect(named(0.2, ["name"], true)).toBe(NARRATIVE_NEUTRAL);
    // A read from before 0.17.0 never says generic: a named referent at 0.5 counts as one.
    expect(
      scoreNarrative(baseToken({ narrative: read({ referentConfidence: 0.5, referentGeneric: null }) })),
    ).toBe(60);
  });

  it("credits a post that announced the coin before it launched, and nothing for a fit alone", () => {
    const announced = read({
      depth: "full",
      xVerdict: "about_this_coin",
      xFit: 0.8,
      xRelation: "launch_announcement",
      xPredatesTokenS: 600,
    });
    expect(scoreNarrative(baseToken({ narrative: announced }))).toBe(65);
    const referenced = read({
      ...announced,
      xRelation: "narrative_reference",
      xPredatesTokenS: X_POST_PREDATES_MIN_S,
    });
    expect(scoreNarrative(baseToken({ narrative: referenced }))).toBe(65);
    // Posted with the launch: nothing yet says anyone cared before the coin existed.
    const withLaunch = read({ ...announced, xPredatesTokenS: 12 });
    expect(scoreNarrative(baseToken({ narrative: withLaunch }))).toBe(NARRATIVE_NEUTRAL);
    // The launcher's own profile, named after the coin: a perfect fit that means nothing.
    const profile = read({
      depth: "full",
      xVerdict: "about_this_coin",
      xFit: 1,
      xRelation: "official_account",
      xPredatesTokenS: null,
    });
    expect(scoreNarrative(baseToken({ narrative: profile }))).toBe(NARRATIVE_NEUTRAL);
    const aboutSearch = read({
      depth: "full",
      xVerdict: "about_this_coin",
      xFit: 0.8,
      xRelation: "search_only",
      xPredatesTokenS: 600,
    });
    expect(scoreNarrative(baseToken({ narrative: aboutSearch }))).toBe(NARRATIVE_NEUTRAL);
  });

  it("punishes an unrelated, spoofed or mismatched post", () => {
    const unrelated = read({
      depth: "full",
      xVerdict: "unrelated",
      xFit: 0,
      xRelation: "narrative_reference",
    });
    expect(scoreNarrative(baseToken({ narrative: unrelated }))).toBe(25);
    const spoofed = read({ depth: "full", xVerdict: "about_this_coin", xFit: 1, xRelation: "spoofed" });
    expect(scoreNarrative(baseToken({ narrative: spoofed }))).toBe(25);
    const mismatch = read({
      depth: "full",
      xVerdict: "related",
      xFit: 0.4,
      xRelation: "narrative_reference",
      flags: ["x_content_mismatch"],
    });
    expect(scoreNarrative(baseToken({ narrative: mismatch }))).toBe(40);
    // A basic read says nothing about the post even when the document carries a verdict.
    expect(scoreNarrative(baseToken({ narrative: read({ xVerdict: "unrelated" }) }))).toBe(NARRATIVE_NEUTRAL);
  });

  it("holds copycats and earlier coins with the same name neutral until the copy's rank is known", () => {
    expect(scoreNarrative(baseToken({ narrative: read({ copiesRecent: true }) }))).toBe(NARRATIVE_NEUTRAL);
    expect(scoreNarrative(baseToken({ narrative: read({ flags: ["copycat", "earlier_same_name"] }) }))).toBe(
      NARRATIVE_NEUTRAL,
    );
    expect(scoreNarrative(baseToken({ narrative: read({ flags: ["earlier_same_name"] }) }))).toBe(
      NARRATIVE_NEUTRAL,
    );
    expect(
      scoreNarrative(
        baseToken({ narrative: read({ copiesRecent: false, flags: ["references_known_coin"] }) }),
      ),
    ).toBe(NARRATIVE_NEUTRAL);
  });

  it("holds a late copy neutral while LATE_COPY_PENALTY is 0, by lineage or by flag, like an early one", () => {
    const late = NARRATIVE_NEUTRAL - LATE_COPY_PENALTY;
    expect(scoreNarrative(baseToken({ narrative: read({ lineageKind: "late_copy" }) }))).toBe(late);
    expect(scoreNarrative(baseToken({ narrative: read({ flags: ["copycat", "late_copy"] }) }))).toBe(late);
    expect(
      scoreNarrative(baseToken({ narrative: read({ lineageKind: "early_copy", copiesRecent: true }) })),
    ).toBe(NARRATIVE_NEUTRAL);
    expect(scoreNarrative(baseToken({ narrative: read({ lineageKind: "copy" }) }))).toBe(NARRATIVE_NEUTRAL);
  });

  it("credits a matched trend and caps the part under a red flag", () => {
    expect(scoreNarrative(baseToken({ narrative: read({ depth: "full", trendMatched: true }) }))).toBe(60);
    const flagged = read({ referentConfidence: 0.9, referentSupport: ["name", "x"], highFlagCount: 1 });
    expect(scoreNarrative(baseToken({ narrative: flagged }))).toBe(NARRATIVE_RED_FLAG_CAP);
    expect(scoreNarrative(baseToken({ narrative: read({ copiesRecent: true, highFlagCount: 2 }) }))).toBe(
      NARRATIVE_RED_FLAG_CAP,
    );
  });

  it("feeds the composite through the narrative weight", () => {
    const plain = scoreToken(baseToken({ ageMinutes: 3 }));
    const strong = scoreToken(
      baseToken({
        ageMinutes: 3,
        narrative: read({ referentConfidence: 0.9, referentSupport: ["name", "x"] }),
      }),
    );
    expect(strong.narrative).toBe(65);
    expect(strong.total).toBeGreaterThan(plain.total);
  });
});
