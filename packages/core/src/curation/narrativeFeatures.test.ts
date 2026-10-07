import { describe, expect, it } from "vitest";
import {
  NARRATIVE_FEATURES,
  narrativeFeatureValues,
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
    ...overrides,
  };
}

const fullRow = (): NarrativeRow =>
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
    expect(Object.keys(v)).toEqual([...NARRATIVE_FEATURES]);
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

  it("records every ns* input on the vector", () => {
    for (const name of NARRATIVE_FEATURES) expect(CANDIDATE_FEATURE_NAMES).toContain(name);
    const features = buildCandidateFeatures(scoredWith(narrativeReadFromRow(fullRow())));
    expect(features.nsXFit).toBe(0.85);
    expect(features.nsCatAnimal).toBe(1);
    expect(buildCandidateFeatures(scoredWith(undefined)).nsDepthFull).toBeNull();
  });

  it("replays the same inputs from the vector", () => {
    for (const r of [row(), fullRow(), row({ depth: "full", trendMatched: false })]) {
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
