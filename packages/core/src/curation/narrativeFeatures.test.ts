import { describe, expect, it } from "vitest";
import {
  ALL_NARRATIVE_FEATURES,
  NARRATIVE_FEATURES_V2,
  NARRATIVE_FEATURES_V3,
  narrativeFeatureValues,
  narrativeIsLateCopy,
  narrativeReferentNamed,
  narrativeFromFeatures,
  narrativeReadFromRow,
  type NarrativeRead,
  type NarrativeRow,
} from "./narrativeFeatures.js";
import { CANDIDATE_FEATURE_NAMES, buildCandidateFeatures, scoredFromFeatures } from "./features.js";
import type { ScoredToken } from "../types.js";

function row(overrides: Partial<NarrativeRow> = {}): NarrativeRow {
  return {
    depth: "basic",
    status: "complete",
    analyzedAt: new Date("2026-10-07T00:00:00Z"),
    categories: [
      { label: "animal", confidence: 0.9 },
      { label: "animal/squirrel", confidence: 0.9 },
      { label: "derivative", confidence: 0.3 },
    ],
    referentLabel: "Peanut (squirrel)",
    referentKind: "famous_animal",
    referentConfidence: 0.97,
    referentSupport: ["name", "description"],
    referentGeneric: false,
    flags: ["references_known_coin"],
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
  };
}

const fullRow = (overrides: Partial<NarrativeRow> = {}): NarrativeRow =>
  row({
    depth: "full",
    xFit: 0.85,
    xVerdict: "about_this_coin",
    xRelation: "launch_announcement",
    xAuthorFollowers: 999,
    xPredatesTokenS: -120,
    xReuseCount: 2,
    trendMatched: true,
    flags: ["references_known_coin", "copycat"],
    warnFlagCount: 1,
    ...overrides,
  });

/** A deep read made by TokenSage rules 0.15.0: a late copy with a self-made X account. */
const lineageRow = (overrides: Partial<NarrativeRow> = {}): NarrativeRow =>
  fullRow({
    flags: ["copycat", "late_copy", "x_account_made_for_coin"],
    lineageKind: "late_copy",
    lineageRank: 15,
    lineageRankOf: 15,
    lineageOfMint: "OriginalMint",
    originalAgeS: 108_000,
    originalCurveProgress: 0.62,
    originalComplete: false,
    siblings1h: 2,
    siblings6h: 9,
    siblings24h: 15,
    logoReuse24h: 4,
    waveLaunches1h: 3,
    waveLaunches6h: 13,
    waveLaunches24h: 15,
    waveRank24h: 13,
    topCategoryInputs: 2,
    xCredibility: 0.032,
    xAccountAgeS: 43_200,
    xAccountMadeForCoin: true,
    xReuseRank: 1,
    trendScore: 0.4,
    ...overrides,
  });

describe("narrativeReadFromRow", () => {
  it("reads a stored row and drops malformed categories", () => {
    const read = narrativeReadFromRow(
      row({ categories: [{ label: "animal", confidence: 0.9 }, { label: 3 }, null, "x", { confidence: 1 }] }),
    );
    expect(read?.categories).toEqual([{ label: "animal", confidence: 0.9 }]);
    expect(read?.depth).toBe("basic");
  });

  it("is undefined for a failed row or none", () => {
    expect(narrativeReadFromRow(row({ status: "failed" }))).toBeUndefined();
    expect(narrativeReadFromRow(null)).toBeUndefined();
  });
});

describe("narrativeFeatureValues", () => {
  it("is null across the board without a read", () => {
    const v = narrativeFeatureValues(undefined);
    expect(Object.keys(v)).toEqual([...ALL_NARRATIVE_FEATURES]);
    expect(Object.values(v).every((x) => x === null)).toBe(true);
  });

  it("knows the theme, referent and flags on a basic read and leaves the X inputs null", () => {
    const v = narrativeFeatureValues(narrativeReadFromRow(row()));
    expect(v).toMatchObject({
      nsDepthFull: 0,
      nsCatAnimal: 1,
      // Below the confidence floor.
      nsCatDerivative: 0,
      nsCatPolitical: 0,
      nsTopCategoryConf: 0.9,
      nsReferentConf: 0.97,
      nsReferentSupportCount: 2,
      nsReferentKnownCoin: 1,
      nsCopycat: 0,
      nsHighFlagCount: 0,
      nsTrendMatched: null,
      nsXRead: null,
      nsXVerdictAbout: null,
      nsXFit: null,
      nsXLaunchAnnouncement: null,
      nsXAuthorFollowersLog: null,
      nsXPredatesTokenMin: null,
    });
  });

  it("reads the post on a full read", () => {
    const v = narrativeFeatureValues(narrativeReadFromRow(fullRow()));
    expect(v).toMatchObject({
      nsDepthFull: 1,
      nsCopycat: 1,
      nsWarnFlagCount: 1,
      nsTrendMatched: 1,
      nsXRead: 1,
      nsXVerdictAbout: 1,
      nsXVerdictUnrelated: 0,
      nsXFit: 0.85,
      nsXLaunchAnnouncement: 1,
      nsXOfficialAccount: 0,
      nsXSpoofed: 0,
      nsXAuthorFollowersLog: 3,
      nsXPredatesTokenMin: -2,
      nsXReuseCount: 2,
    });
  });

  it("marks a full read without a readable post as read-nothing, not unknown", () => {
    const v = narrativeFeatureValues(narrativeReadFromRow(row({ depth: "full", trendMatched: false })));
    expect(v).toMatchObject({
      nsDepthFull: 1,
      nsXRead: 0,
      nsXVerdictAbout: 0,
      nsXLaunchAnnouncement: 0,
      nsXFit: null,
      nsXAuthorFollowersLog: null,
      nsTrendMatched: 0,
    });
  });

  it("a copycat flag counts without copiesRecent, and copiesRecent counts without the flag", () => {
    expect(narrativeFeatureValues(narrativeReadFromRow(row({ flags: ["copycat"] }))).nsCopycat).toBe(1);
    expect(narrativeFeatureValues(narrativeReadFromRow(row({ copiesRecent: true }))).nsCopycat).toBe(1);
  });
});

describe("round trip through a stored feature vector", () => {
  const scoredWith = (narrative: NarrativeRead | undefined): ScoredToken => ({
    mintAddress: "m",
    priceUsd: 0.001,
    marketCapUsd: 20_000,
    narrativeTags: [],
    narrative,
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
  });

  it("reads the lineage, wave, X account and trend score of a rules-0.15.0 row, and leaves older rows unknown", () => {
    const old = narrativeFeatureValues(narrativeReadFromRow(fullRow()));
    for (const name of NARRATIVE_FEATURES_V2) expect(old[name]).toBeNull();
    const v2 = narrativeFeatureValues(narrativeReadFromRow(lineageRow()));
    expect(v2).toMatchObject({
      nsLineageOriginal: 0,
      nsLineageEarlyCopy: 0,
      nsLineageLateCopy: 1,
      nsCopyRank: 15,
      nsCopyRankOf: 15,
      nsOriginalAgeMin: 1800,
      nsOriginalCurveProgress: 0.62,
      nsOriginalGraduated: 0,
      nsSiblings1h: 2,
      nsSiblings6h: 9,
      nsSiblings24h: 15,
      nsLogoReuse24h: 4,
      nsWaveLaunches1h: 3,
      nsWaveLaunches6h: 13,
      nsWaveLaunches24h: 15,
      nsWaveRank24h: 13,
      nsTopCategoryInputs: 2,
      nsXCredibility: 0.032,
      nsXAccountAgeDays: 0.5,
      nsXAccountMadeForCoin: 1,
      nsXReuseRank: 1,
      nsTrendScore: 0.4,
    });
    // The X account facts need the post or profile read; the lineage does not.
    const basic = narrativeFeatureValues(
      narrativeReadFromRow(lineageRow({ depth: "basic", xRelation: null, xVerdict: null })),
    );
    expect(basic.nsLineageLateCopy).toBe(1);
    expect(basic.nsXCredibility).toBeNull();
    expect(basic.nsTrendScore).toBeNull();
    expect(narrativeIsLateCopy(narrativeReadFromRow(lineageRow())!)).toBe(true);
    expect(narrativeIsLateCopy(narrativeReadFromRow(fullRow())!)).toBeNull();
    expect(
      narrativeIsLateCopy(narrativeReadFromRow(lineageRow({ lineageKind: "copy", flags: ["copycat"] }))!),
    ).toBe(false);
    expect(narrativeIsLateCopy(narrativeReadFromRow(row({ flags: ["late_copy"] }))!)).toBe(true);
  });

  it("tells a kind-only referent (rules 0.17.0) from a named one, and both from none", () => {
    // A named referent, as every read before 0.17.0 carried: generic unset or false.
    const named = narrativeFeatureValues(narrativeReadFromRow(row()));
    expect(named).toMatchObject({ nsReferentGeneric: 0, nsReferentNamed: 1, nsReferentConf: 0.97 });
    const older = narrativeFeatureValues(narrativeReadFromRow(row({ referentGeneric: null })));
    expect(older).toMatchObject({ nsReferentGeneric: 0, nsReferentNamed: 1 });
    // FROGMAN: {kind: "animal", label: "frog", generic: true, confidence: 0.38}.
    const frog = narrativeReadFromRow(
      row({
        referentLabel: "frog",
        referentKind: "animal",
        referentConfidence: 0.38,
        referentSupport: ["name"],
        referentGeneric: true,
      }),
    )!;
    expect(narrativeReferentNamed(frog)).toBe(false);
    expect(narrativeFeatureValues(frog)).toMatchObject({
      nsReferentGeneric: 1,
      nsReferentNamed: 0,
      nsReferentConf: 0.38,
      nsReferentSupportCount: 1,
    });
    const none = narrativeReadFromRow(
      row({
        referentLabel: null,
        referentKind: null,
        referentConfidence: null,
        referentSupport: [],
        referentGeneric: null,
      }),
    )!;
    expect(narrativeReferentNamed(none)).toBe(false);
    expect(narrativeFeatureValues(none)).toMatchObject({
      nsReferentGeneric: 0,
      nsReferentNamed: 0,
      nsReferentConf: 0,
    });
    // An unresolved lineage says nothing about which copy the coin is.
    const unresolved = narrativeFeatureValues(
      narrativeReadFromRow(lineageRow({ lineageKind: "unknown", flags: [] })),
    );
    expect(unresolved.nsLineageOriginal).toBeNull();
    expect(unresolved.nsLineageLateCopy).toBeNull();
    expect(unresolved.nsCopyRank).toBe(15);
  });

  it("records every ns* input on the vector", () => {
    for (const name of ALL_NARRATIVE_FEATURES) expect(CANDIDATE_FEATURE_NAMES).toContain(name);
    // The livestream inputs (added after) follow the narrative ones.
    const lastNarrative = CANDIDATE_FEATURE_NAMES.indexOf("livestreamLive") - 1;
    expect(CANDIDATE_FEATURE_NAMES.indexOf("nsReferentNamed")).toBe(lastNarrative);
    expect(CANDIDATE_FEATURE_NAMES.indexOf("nsTrendScore")).toBe(
      lastNarrative - NARRATIVE_FEATURES_V3.length,
    );
    const features = buildCandidateFeatures(scoredWith(narrativeReadFromRow(fullRow())));
    expect(features.nsXFit).toBe(0.85);
    expect(features.nsCatAnimal).toBe(1);
    expect(buildCandidateFeatures(scoredWith(undefined)).nsDepthFull).toBeNull();
  });

  it("replays the same inputs from the vector", () => {
    const frog = row({
      referentKind: "animal",
      referentConfidence: 0.38,
      referentSupport: ["name"],
      referentGeneric: true,
    });
    for (const r of [row(), fullRow(), row({ depth: "full", trendMatched: false }), lineageRow(), frog]) {
      const features = buildCandidateFeatures(scoredWith(narrativeReadFromRow(r)));
      const replayed = scoredFromFeatures(features, 0.001, 20_000);
      expect(narrativeFeatureValues(replayed.narrative)).toEqual(
        narrativeFeatureValues(narrativeReadFromRow(r)),
      );
    }
    expect(
      scoredFromFeatures(buildCandidateFeatures(scoredWith(undefined)), 0.001, 20_000).narrative,
    ).toBeUndefined();
    expect(narrativeFromFeatures({})).toBeUndefined();
  });
});
