// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { NarrativeRead } from "@trenchscanner/core";
import { secondLookDue } from "./scanJob.js";

const read = (overrides: Partial<NarrativeRead> = {}): NarrativeRead => ({
  depth: "full",
  status: "complete",
  analyzedAt: new Date("2026-10-07T10:00:00Z"),
  categories: [],
  referentLabel: null,
  referentKind: null,
  referentConfidence: null,
  referentSupport: [],
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
});

describe("secondLookDue", () => {
  it("is due when a dated deep read is newer than the token's last decision, or there was none", () => {
    expect(secondLookDue({ narrative: read() }, {})).toBe(true);
    expect(secondLookDue({ narrative: read() }, { lastDecisionAt: new Date("2026-10-07T09:59:00Z") })).toBe(
      true,
    );
    expect(secondLookDue({ narrative: read() }, { lastDecisionAt: new Date("2026-10-07T10:01:00Z") })).toBe(
      false,
    );
  });

  it("measures newness by our own store time, not TokenSage's analyzedAt", () => {
    // Analyzed (by TokenSage's clock) before our decision, but stored after it: the decision was
    // made without the read, so a second look is due.
    const storedLater = read({
      analyzedAt: new Date("2026-10-07T09:50:00Z"),
      checkedAt: new Date("2026-10-07T10:05:00Z"),
    });
    expect(
      secondLookDue({ narrative: storedLater }, { lastDecisionAt: new Date("2026-10-07T10:00:00Z") }),
    ).toBe(true);
    // Stored before the decision - the decision already saw it, whatever TokenSage's clock says.
    const storedEarlier = read({
      analyzedAt: new Date("2026-10-07T10:30:00Z"),
      checkedAt: new Date("2026-10-07T09:55:00Z"),
    });
    expect(
      secondLookDue({ narrative: storedEarlier }, { lastDecisionAt: new Date("2026-10-07T10:00:00Z") }),
    ).toBe(false);
  });

  it("is never due without a dated deep read", () => {
    expect(secondLookDue({}, {})).toBe(false);
    expect(secondLookDue({ narrative: read({ depth: "basic" }) }, {})).toBe(false);
    expect(secondLookDue({ narrative: read({ analyzedAt: null }) }, {})).toBe(false);
  });
});
