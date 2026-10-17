import { describe, expect, it } from "vitest";
import {
  gateCriteriaUncheckedOffline,
  parseModelGate,
  passesModelGate,
  passesModelGateOnFeatures,
} from "./modelGate.js";
import { buildCandidateFeatures } from "./features.js";
import { EMPTY_TRADE_FLOW } from "./tradeFlow.js";
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

  it("names the criteria a stored row can't be checked against", () => {
    expect(gateCriteriaUncheckedOffline(gate)).toEqual([]);
    expect(
      gateCriteriaUncheckedOffline({
        ...gate,
        excludeCriticalRiskFlags: true,
        narrativeKeywords: ["dog"],
        minScore: 60,
        excludeCopycats: true,
      }),
    ).toEqual(["excludeCriticalRiskFlags", "narrativeKeywords", "minScore", "excludeCopycats"]);
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
