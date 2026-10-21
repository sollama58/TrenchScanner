import { describe, expect, it } from "vitest";
import {
  gateCriteriaUncheckedOffline,
  gateInputOnsets,
  parseModelGate,
  passesModelGate,
  passesModelGateOnFeatures,
  unrecordedGateInputs,
} from "./modelGate.js";
import { buildCandidateFeatures, scoredFromFeatures } from "./features.js";
import { EMPTY_TRADE_FLOW } from "./tradeFlow.js";
import { scoreToken } from "../scoring/scorer.js";
import type { NarrativeRead } from "./narrativeFeatures.js";
import type { FilterCriteria, ScoredToken } from "../types.js";

function token(overrides: Partial<ScoredToken> = {}): ScoredToken {
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

/** A gate shaped like a real saved filter: a band, a launchpad, floors and wallet ceilings. */
const gate: FilterCriteria = {
  mcapMin: 50_000,
  mcapMax: 400_000,
  launchpads: ["pumpfun"],
  minVolumeMcapRatio: 0.5,
  minHolderGrowthPct: 5,
  maxTop10HolderPct: 35,
  maxFreshTop10WalletPct: 40,
  maxEmptyTop10WalletPct: 60,
  maxLinkedWalletPct: 20,
  minTokenAgeMinutes: 2,
  maxTokenAgeMinutes: 120,
  minFirstBuyersHolding: 3,
};

function read(overrides: Partial<NarrativeRead> = {}): NarrativeRead {
  return {
    depth: "basic",
    status: "complete",
    analyzedAt: null,
    categories: [{ label: "animal", confidence: 0.9 }],
    referentLabel: null,
    referentKind: null,
    referentConfidence: null,
    referentSupport: [],
    referentGeneric: null,
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
    feeDestination: null,
    feeCreatorShare: null,
    feeMutable: null,
    ...overrides,
  };
}

function withScore(row: ScoredToken): ScoredToken {
  return { ...row, score: scoreToken(row) };
}

const passing = token({
  launchpad: "pumpfun",
  volumeToMcapRatio: 1,
  holderGrowth10mPct: 12,
  top10HolderPct: 25,
  freshTop10WalletPct: 20,
  emptyTop10WalletPct: 30,
  linkedWalletPct: 5,
  ageMinutes: 30,
  tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersHoldingCut: 6 },
});

describe("model gates", () => {
  it("passes a token the filter would match, once every capped wallet figure is in", () => {
    expect(passesModelGate(passing, gate)).toBe(true);
    // matchesFilter alone lets an unknown ceiling past; the gate waits for the reading.
    expect(passesModelGate(token({ ...passing, emptyTop10WalletPct: undefined }), gate)).toBe(false);
    // A ceiling it doesn't hold to a wallet figure still skips an unknown, as the filter does.
    expect(passesModelGate(token({ ...passing, top10HolderPct: undefined }), gate)).toBe(true);
    const strict = { unknownFails: true };
    const riskGate = { ...gate, maxRiskScore: 50 };
    expect(passesModelGate(token({ ...passing, riskScore: undefined }), riskGate)).toBe(true);
    expect(passesModelGate(token({ ...passing, riskScore: undefined }), riskGate, strict)).toBe(false);
    expect(
      passesModelGateOnFeatures(
        { ...buildCandidateFeatures(passing), riskScore: null },
        riskGate,
        new Set(),
        strict,
      ),
    ).toBe(false);
    const growthGate = { ...gate, minHolderGrowthPct: 5 };
    expect(passesModelGate(token({ ...passing, holderGrowth10mPct: undefined }), growthGate, strict)).toBe(
      false,
    );
  });

  it("reads a training row's stored inputs the way it reads the live token", () => {
    const cases: [string, ScoredToken][] = [
      ["passing", passing],
      ["under the band", token({ ...passing, marketCapUsd: 40_000 })],
      ["wrong launchpad", token({ ...passing, launchpad: "stonks" })],
      ["unknown launchpad", token({ ...passing, launchpad: undefined })],
      ["thin volume", token({ ...passing, volumeToMcapRatio: 0.2 })],
      ["unknown growth", token({ ...passing, holderGrowth10mPct: undefined })],
      ["concentrated", token({ ...passing, top10HolderPct: 50 })],
      ["unknown top 10", token({ ...passing, top10HolderPct: undefined })],
      ["fresh wallets", token({ ...passing, freshTop10WalletPct: 60 })],
      ["fresh over the top 25", token({ ...passing, freshTopHolderCount: 12, freshTopHoldersChecked: 25 })],
      ["empty unknown", token({ ...passing, emptyTop10WalletPct: undefined })],
      ["linked", token({ ...passing, linkedWalletPct: 30 })],
      ["too young", token({ ...passing, ageMinutes: 1 })],
      ["too old", token({ ...passing, ageMinutes: 200 })],
      [
        "first buyers sold",
        token({ ...passing, tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersHoldingCut: 1 } }),
      ],
      ["first buyers unread", token({ ...passing, tradeFlow: undefined })],
    ];
    for (const [name, scored] of cases) {
      const offline = passesModelGateOnFeatures(buildCandidateFeatures(scored), gate);
      expect([name, offline]).toEqual([name, passesModelGate(scored, gate)]);
    }
  });

  it("skips a criterion on an input not recorded yet when the row was banked", () => {
    const stored = buildCandidateFeatures(passing);
    // A row banked before the launchpad and the first buyers' holding were recorded.
    const older = { ...stored, launchpadStonks: null, firstBuyersHoldingCut: null };
    const newer = new Date("2026-10-17T00:00:00Z");
    const rows = [
      { anchorAt: new Date("2026-10-10T00:00:00Z"), features: older },
      { anchorAt: newer, features: stored },
    ];
    const onsets = gateInputOnsets(rows);
    const unrecorded = unrecordedGateInputs(rows[0]!.anchorAt, onsets);
    expect([...unrecorded].sort()).toEqual(["firstBuyersHoldingCut", "launchpadStonks"]);
    expect(passesModelGateOnFeatures(older, gate)).toBe(false);
    expect(passesModelGateOnFeatures(older, gate, unrecorded)).toBe(true);
    // A launchpad not recorded yet reads as Pump.fun, the only one scanned then.
    expect(passesModelGateOnFeatures(older, { ...gate, launchpads: ["stonks"] }, unrecorded)).toBe(false);
    // Once the input is recorded, an unknown reading fails again, as it does live.
    expect(unrecordedGateInputs(newer, onsets).size).toBe(0);
    expect(
      passesModelGateOnFeatures(
        { ...stored, firstBuyersHoldingCut: null },
        gate,
        unrecordedGateInputs(newer, onsets),
      ),
    ).toBe(false);
    // The other criteria still hold on the older row.
    expect(passesModelGateOnFeatures({ ...older, top10HolderPct: 50 }, gate, unrecorded)).toBe(false);
  });

  it("names the criteria a stored row can't be checked against", () => {
    expect(gateCriteriaUncheckedOffline(gate)).toEqual([]);
    // Risk-flag names and free-text keywords are not in the vector. minScore, copycats and a
    // top-level category are, so they are not skipped. A sub-label is not stored.
    expect(
      gateCriteriaUncheckedOffline({
        ...gate,
        excludeCriticalRiskFlags: true,
        narrativeKeywords: ["dog"],
        minScore: 60,
        narrativeCategories: ["animal"],
        excludeCopycats: true,
      }),
    ).toEqual(["excludeCriticalRiskFlags", "narrativeKeywords"]);
    expect(gateCriteriaUncheckedOffline({ ...gate, narrativeCategories: ["animal/dog"] })).toEqual([
      "narrativeCategories",
    ]);
  });

  it("applies minScore, categories, copycats, red flags, unrelated X, trend and late copies when the row has them", () => {
    const scored = withScore(
      token({ ...passing, narrative: read({ lineageKind: "original" }), hasTwitter: false }),
    );
    const features = buildCandidateFeatures(scored);
    const cases: [string, FilterCriteria, ScoredToken][] = [
      ["under the score floor", { ...gate, minScore: scored.score.total + 1 }, scored],
      ["over the score floor", { ...gate, minScore: 0 }, scored],
      ["category hit", { ...gate, narrativeCategories: ["animal"] }, scored],
      ["category miss", { ...gate, narrativeCategories: ["political"] }, scored],
      [
        "copycat",
        { ...gate, excludeCopycats: true },
        withScore(token({ ...passing, narrative: read({ copiesRecent: true, lineageKind: "original" }) })),
      ],
      [
        "red flag",
        { ...gate, excludeNarrativeRedFlags: true },
        withScore(token({ ...passing, narrative: read({ highFlagCount: 1, lineageKind: "original" }) })),
      ],
      [
        "unrelated X",
        { ...gate, excludeUnrelatedX: true },
        withScore(
          token({
            ...passing,
            hasTwitter: true,
            narrative: read({ depth: "full", xVerdict: "unrelated", lineageKind: "original" }),
          }),
        ),
      ],
      [
        "no X link",
        { ...gate, excludeUnrelatedX: true },
        withScore(token({ ...passing, hasTwitter: false, narrative: read({ lineageKind: "original" }) })),
      ],
      [
        "trend matched",
        { ...gate, requireTrendMatch: true },
        withScore(
          token({
            ...passing,
            narrative: read({ depth: "full", trendMatched: true, lineageKind: "original" }),
          }),
        ),
      ],
      [
        "late copy",
        { ...gate, excludeLateCopies: true },
        withScore(token({ ...passing, narrative: read({ lineageKind: "late_copy" }) })),
      ],
      [
        "not a late copy",
        { ...gate, excludeLateCopies: true },
        withScore(token({ ...passing, narrative: read({ lineageKind: "original" }) })),
      ],
    ];
    for (const [name, g, row] of cases) {
      const offline = passesModelGateOnFeatures(buildCandidateFeatures(row), g);
      expect([name, offline]).toEqual([name, passesModelGate(row, g)]);
    }
    // The recomputed score is today's score, not the stored legacy composite.
    expect(scoredFromFeatures(features, 1, scored.marketCapUsd).score.total).toBe(scored.score.total);
  });

  it("skips critical risk flags, keyword text and category sub-labels, which the row cannot answer", () => {
    const flagged = token({ ...passing, riskFlags: ["Creator history of rugged tokens"] });
    const flags = { ...gate, excludeCriticalRiskFlags: true };
    expect(passesModelGate(flagged, flags)).toBe(false);
    expect(passesModelGateOnFeatures(buildCandidateFeatures(flagged), flags)).toBe(true);

    const keywords = { ...gate, narrativeKeywords: ["moon"] };
    const plain = token({ ...passing, name: "Safe", symbol: "SAFE" });
    expect(passesModelGate(plain, keywords)).toBe(false);
    expect(passesModelGateOnFeatures(buildCandidateFeatures(plain), keywords)).toBe(true);

    // "animal/dog" is not a stored bit. The same vector passes offline and the live token fails.
    const sub = { ...gate, narrativeCategories: ["animal/dog"] };
    const cat = withScore(
      token({ ...passing, narrative: read({ categories: [{ label: "political", confidence: 0.9 }] }) }),
    );
    expect(passesModelGate(cat, sub)).toBe(false);
    expect(passesModelGateOnFeatures(buildCandidateFeatures(cat), sub)).toBe(true);
    expect(gateCriteriaUncheckedOffline(sub)).toEqual(["narrativeCategories"]);
  });

  it("skips narrative criteria on a row banked before the read was recorded", () => {
    const stored = buildCandidateFeatures(
      withScore(token({ ...passing, narrative: read({ lineageKind: "original" }) })),
    );
    const older = { ...stored, nsDepthFull: null };
    const earlier = new Date("2026-10-01T00:00:00Z");
    const later = new Date("2026-10-20T00:00:00Z");
    const onsets = gateInputOnsets([
      { anchorAt: earlier, features: older },
      { anchorAt: later, features: stored },
    ]);
    const unrecorded = unrecordedGateInputs(earlier, onsets);
    expect(unrecorded.has("nsDepthFull")).toBe(true);
    const copycats = { ...gate, excludeCopycats: true };
    expect(passesModelGateOnFeatures(older, copycats, unrecorded)).toBe(true);
    // Once the read is being recorded, no read fails closed, as it does live.
    expect(
      passesModelGateOnFeatures(
        { ...stored, nsDepthFull: null },
        copycats,
        unrecordedGateInputs(later, onsets),
      ),
    ).toBe(false);
  });

  it("reads a stored copy only when it carries a market-cap band", () => {
    expect(parseModelGate({ mcapMin: 1, mcapMax: 2, maxRiskScore: null })).toEqual({
      mcapMin: 1,
      mcapMax: 2,
      maxRiskScore: null,
    });
    expect(parseModelGate({ mcapMin: 1 })).toBeNull();
    expect(parseModelGate(null)).toBeNull();
    expect(parseModelGate([1, 2])).toBeNull();
  });
});
