import { describe, expect, it } from "vitest";
import {
  buildCandidateFeatures,
  scoredFromFeatures,
  CANDIDATE_FEATURE_NAMES,
  LEARNER_FEATURE_NAMES,
  RETIRED_LEARNER_INPUTS,
  learnerSubset,
  maskKnownBadInputs,
  withLaunchAge,
  ageMayBePoolAge,
  isRawWalletRiskRow,
  AGE_FROM_LAUNCH_SINCE,
  WALLET_RISK_PERCENTILE_SINCE,
  SOCIALS_UNREAD_NULL_SINCE,
  EMPTY_WALLETS_UNPRICED_NULL_SINCE,
  HOURLY_ROWS_WAIT_SINCE,
  BUNDLED_SUPPLY_POINT_IN_TIME_FROM,
  HOLDER_TRANSFER_LINKS_WINDOW,
  HOLDER_TRANSFER_LINKS_READ_SINCE,
  STONKS_FEE_WALLET_EXCLUDED_SINCE,
  isPreFeeWalletStonksRow,
  NARRATIVE_READ_AT_DECISION_SINCE,
  NS_RULES_VERSION_MARKER_SINCE,
  SOCIAL_BITS_FROM_DISCOVERY_SINCE,
  withCurrentNarrativeTiming,
  TRADE_FLOW_FAKE_ZEROS_UNTIL,
  VOLUME_ACCEL_YOUNG_NULL_SINCE,
  WEEKEND_FLAG_FROM,
  FRESH_QUOTE_GAP_SINCE,
  PATH_TAPE_REFILL_SINCE,
  PATH_RETURNS_ACROSS_GAPS_SINCE,
  PRICE_PATH_FEATURES,
  SOCIAL_LIST_OUTAGE,
  SNIPER_SHARE_CLOSED_ACCOUNTS_DROPPED_SINCE,
  LAUNCH_FACT_FEATURES,
  MARKET_LEARNER_FEATURE_NAMES,
  MARKET_TOKENSAGE_INPUTS,
  WALLET_SCORE_FEATURES,
  WINNER_FOLLOW_FEATURES,
  CURVE_PATH_FEATURES,
  DEV_LAUNCH_FEATURES,
} from "./features.js";
import { NS_RULES_VERSION } from "./narrativeFeatures.js";
import { EMPTY_TRADE_FLOW } from "./tradeFlow.js";
import { EMPTY_CURVE_PATH } from "./curveTape.js";
import { EMPTY_DEV_LAUNCH } from "../wallets/devLaunchScore.js";
import type { ScoredToken } from "../types.js";

function scored(overrides: Partial<ScoredToken> = {}): ScoredToken {
  return {
    mintAddress: "mint111",
    priceUsd: 0.0001,
    marketCapUsd: 150_000,
    volume24hUsd: 200_000,
    volumeToMcapRatio: 1.3,
    buys24h: 700,
    sells24h: 300,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 80, holderHealth: 70, age: 100, narrative: 40, total: 75 },
    ...overrides,
  };
}

describe("buildCandidateFeatures - short-window derivations", () => {
  it("derives the 1h buy ratio, and nulls it when the hour saw no trades", () => {
    expect(buildCandidateFeatures(scored({ buys1h: 80, sells1h: 20 })).buyRatio1h).toBeCloseTo(0.8);
    expect(buildCandidateFeatures(scored({ buys1h: 0, sells1h: 0 })).buyRatio1h).toBeNull();
    expect(buildCandidateFeatures(scored({})).buyRatio1h).toBeNull();
  });

  it("derives the 5m buy ratio from the 5m counts, and nulls it with no trades", () => {
    const f = buildCandidateFeatures(scored({ buys5m: 30, sells5m: 10 }));
    expect(f.buys5m).toBe(30);
    expect(f.sells5m).toBe(10);
    expect(f.buyRatio5m).toBeCloseTo(0.75);
    expect(buildCandidateFeatures(scored({ buys5m: 0, sells5m: 0 })).buyRatio5m).toBeNull();
    expect(buildCandidateFeatures(scored({})).buys5m).toBeNull();
    const back = scoredFromFeatures(f, 1, 100_000);
    expect(back.buys5m).toBe(30);
    expect(back.sells5m).toBe(10);
  });

  it("keeps the retired inputs recorded but out of the learners' default list", () => {
    for (const name of RETIRED_LEARNER_INPUTS) {
      expect(CANDIDATE_FEATURE_NAMES).toContain(name);
      expect(LEARNER_FEATURE_NAMES).not.toContain(name);
    }
    expect(LEARNER_FEATURE_NAMES.length).toBe(CANDIDATE_FEATURE_NAMES.length - RETIRED_LEARNER_INPUTS.size);
    for (const name of ["priceChange5mPct", "volume5mUsd", "ageMinutes", "buyRatio5m", "ctxHourSin"] as const)
      expect(LEARNER_FEATURE_NAMES).toContain(name);
    // The tape's coverage is a learner input and rides with the path block, live and replayed.
    expect(LEARNER_FEATURE_NAMES).toContain("pathGapMinutes");
    expect(PRICE_PATH_FEATURES).toContain("pathGapMinutes");
    expect(learnerSubset(["scoreTotal", "ageMinutes", "hasTelegram"])).toEqual(["ageMinutes"]);
  });

  it("derives 1h churn against mcap", () => {
    const f = buildCandidateFeatures(scored({ volume1hUsd: 30_000 }));
    expect(f.volume1hToMcapRatio).toBeCloseTo(0.2);
    expect(buildCandidateFeatures(scored({})).volume1hToMcapRatio).toBeNull();
  });

  it("derives volume acceleration as the 5m pace over the 1h actual", () => {
    // 5k in 5 minutes extrapolates to 60k/hour; over an actual 30k hour that's 2x - speeding up.
    const f = buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 30_000 }));
    expect(f.volumeAccel).toBeCloseTo(2);
    // A zero-volume hour has no pace to compare against - null, not Infinity.
    expect(buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 0 })).volumeAccel).toBeNull();
    // A launch younger than the 5-minute window has all its volume in both windows: 12 by
    // construction, so unknown rather than "accelerating twelvefold". Five minutes old measures.
    expect(
      buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 5_000, ageMinutes: 3 })).volumeAccel,
    ).toBeNull();
    expect(
      buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 5_000, ageMinutes: 5 })).volumeAccel,
    ).toBeCloseTo(12);
    // Unknown age leaves the measurement alone.
    expect(
      buildCandidateFeatures(scored({ volume5mUsd: 5_000, volume1hUsd: 5_000 })).volumeAccel,
    ).toBeCloseTo(12);
    // The windows are per pair: an hour-old token whose canonical pair is a three-minute-old
    // PumpSwap pool (just graduated) has every pool trade in both windows, so unknown again.
    const now = new Date("2026-10-05T12:00:00Z");
    expect(
      buildCandidateFeatures(
        scored({
          volume5mUsd: 5_000,
          volume1hUsd: 5_000,
          ageMinutes: 60,
          pairCreatedAt: new Date(now.getTime() - 3 * 60_000),
        }),
        now,
      ).volumeAccel,
    ).toBeNull();
    expect(
      buildCandidateFeatures(
        scored({
          volume5mUsd: 5_000,
          volume1hUsd: 30_000,
          ageMinutes: 60,
          pairCreatedAt: new Date(now.getTime() - 6 * 60_000),
        }),
        now,
      ).volumeAccel,
    ).toBeCloseTo(2);
  });

  it("records quote staleness and token-minus-pair age", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const readAt = new Date(now.getTime() - 45_000);
    const f = buildCandidateFeatures(
      scored({
        marketReadAt: readAt,
        graduated: true,
        ageMinutes: 30,
        pairCreatedAt: new Date(now.getTime() - 5 * 60_000),
        freshQuote: {
          priceUsd: 1,
          marketCapUsd: 1_000_000,
          fetchedAt: new Date(now.getTime() - 2_000),
          updatedAt: new Date(now.getTime() - 3_000),
        },
      }),
      now,
    );
    expect(f.dexQuoteAgeSec).toBeCloseTo(45);
    expect(f.jupiterQuoteAgeSec).toBeCloseTo(3);
    expect(f.tokenMinusPairAgeMin).toBeCloseTo(25);
  });

  it("records the pair's age in minutes, null without a pair time", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    const at = (pairCreatedAt?: Date) =>
      buildCandidateFeatures(scored({ pairCreatedAt }), now).pairAgeMinutes;
    expect(at(new Date(now.getTime() - 90 * 60_000))).toBeCloseTo(90);
    expect(at(undefined)).toBeNull();
    expect(at(new Date(Number.NaN))).toBeNull();
    // A pair time a little ahead of the clock is skew, read as just opened.
    expect(at(new Date(now.getTime() + 5_000))).toBe(0);
  });

  it("records every declared feature name, unknowns as null", () => {
    const f = buildCandidateFeatures(scored({}));
    for (const name of CANDIDATE_FEATURE_NAMES) {
      expect(f).toHaveProperty(name);
    }
    expect(f.priceChange5mPct).toBeNull();
    expect(f.priceChange1hPct).toBeNull();
  });

  it("passes observed short-window values straight through", () => {
    const f = buildCandidateFeatures(
      scored({ priceChange5mPct: -12, priceChange1hPct: 40, buys1h: 10, sells1h: 5 }),
    );
    expect(f.priceChange5mPct).toBe(-12);
    expect(f.priceChange1hPct).toBe(40);
    expect(f.buys1h).toBe(10);
    expect(f.sells1h).toBe(5);
  });
});

describe("scoredFromFeatures - replay round trip", () => {
  it("reconstructs the fields the heuristic gate reads, short-window included", () => {
    const original = scored({
      buys1h: 80,
      sells1h: 20,
      priceChange5mPct: -30,
      volume1hUsd: 30_000,
      liquidityUsd: 40_000,
      graduated: true,
      ageMinutes: 90,
    });
    const replayed = scoredFromFeatures(
      buildCandidateFeatures(original),
      original.priceUsd,
      original.marketCapUsd,
    );
    expect(replayed.buys1h).toBe(80);
    expect(replayed.sells1h).toBe(20);
    expect(replayed.priceChange5mPct).toBe(-30);
    expect(replayed.volumeToMcapRatio).toBeCloseTo(1.3);
    expect(replayed.graduated).toBe(true);
    expect(replayed.ageMinutes).toBe(90);
  });

  it("replays the live gate's market cap and top-25 fresh-wallet count, not the anchor's cap", () => {
    const f = { mcapUsd: 80_000, freshTopHolderCount: 9, freshTopHoldersChecked: 25 };
    const replayed = scoredFromFeatures(f, 0.0001, 120_000);
    expect(replayed.marketCapUsd).toBe(80_000);
    expect(replayed.freshTopHolderCount).toBe(9);
    expect(replayed.freshTopHoldersChecked).toBe(25);
    expect(scoredFromFeatures({}, 0.0001, 120_000).marketCapUsd).toBe(120_000);
  });

  it("flags a Stonks coin 1 and a Pump.fun coin 0, leaves an unknown launchpad null, and replays it", () => {
    const stonks = buildCandidateFeatures(scored({ launchpad: "stonks" }));
    expect(stonks.launchpadStonks).toBe(1);
    expect(buildCandidateFeatures(scored({ launchpad: "pumpfun" })).launchpadStonks).toBe(0);
    expect(buildCandidateFeatures(scored()).launchpadStonks).toBeNull();
    expect(buildCandidateFeatures(scored({ launchpad: "bonk" })).launchpadStonks).toBeNull();
    expect(scoredFromFeatures(stonks, 0.0001, 150_000).launchpad).toBe("stonks");
    expect(scoredFromFeatures({ scoreTotal: 75 }, 0.0001, 150_000).launchpad).toBeUndefined();
    expect(CANDIDATE_FEATURE_NAMES.at(-1)).toBe("devLaunchFamilyLaunches");
    // Appended on 2026-10-16: the scored top-10 count behind walletRiskTop10Max.
    expect(CANDIDATE_FEATURE_NAMES).toContain("walletRiskScoredTop10");
  });

  it("records the curve path, replays it, and reads it in the learners", () => {
    const curvePath = { ...EMPTY_CURVE_PATH, curveRet10sPct: 4.2, curveNetSol1m: 3.5 };
    const features = buildCandidateFeatures(scored({ curvePath }));
    expect(features.curveRet10sPct).toBe(4.2);
    expect(features.curveNetSol1m).toBe(3.5);
    expect(buildCandidateFeatures(scored()).curveRet10sPct).toBeNull();
    expect(scoredFromFeatures(features, 0.0001, 150_000).curvePath?.curveNetSol1m).toBe(3.5);
    for (const name of CURVE_PATH_FEATURES) expect(LEARNER_FEATURE_NAMES).toContain(name);
  });

  it("records the dev launch reading, replays it, and reads it in the learners", () => {
    const devLaunch = {
      ...EMPTY_DEV_LAUNCH,
      devLaunchRisk: 62.5,
      devLaunchPrior: 4,
      devLaunchFamilyCreators: 0,
    };
    const features = buildCandidateFeatures(scored({ devLaunch }));
    expect(features.devLaunchRisk).toBe(62.5);
    expect(features.devLaunchPrior).toBe(4);
    expect(features.devLaunchFamilyCreators).toBe(0);
    expect(buildCandidateFeatures(scored()).devLaunchRisk).toBeNull();
    expect(scoredFromFeatures(features, 0.0001, 150_000).devLaunch?.devLaunchPrior).toBe(4);
    for (const name of DEV_LAUNCH_FEATURES) expect(LEARNER_FEATURE_NAMES).toContain(name);
  });

  it("says whether the age counts from the launch or the pool, null without an age, and replays it", () => {
    const launch = buildCandidateFeatures(scored({ ageMinutes: 90, ageFromLaunch: true }));
    expect(launch.ageSource).toBe(1);
    expect(buildCandidateFeatures(scored({ ageMinutes: 1, ageFromLaunch: false })).ageSource).toBe(0);
    expect(buildCandidateFeatures(scored({ ageMinutes: undefined })).ageSource).toBeNull();
    expect(LEARNER_FEATURE_NAMES).toContain("ageSource");
    expect(scoredFromFeatures(launch, 0.0001, 150_000).ageFromLaunch).toBe(true);
    expect(scoredFromFeatures({ scoreTotal: 75 }, 0.0001, 150_000).ageFromLaunch).toBeUndefined();
  });

  it("records the market source as its code, a learner input, and replays it; null without one", () => {
    const live = buildCandidateFeatures(scored({ marketSource: "dexscreener_live" }));
    expect(live.mktSource).toBe(2);
    expect(buildCandidateFeatures(scored({ marketSource: "dexscreener" })).mktSource).toBe(1);
    expect(buildCandidateFeatures(scored({ marketSource: "jupiter" })).mktSource).toBe(3);
    expect(buildCandidateFeatures(scored({ marketSource: "gecko" })).mktSource).toBe(4);
    // A reading built without one, and every row banked before the marker.
    expect(buildCandidateFeatures(scored()).mktSource).toBeNull();
    expect(scoredFromFeatures(live, 0.0001, 150_000).marketSource).toBe("dexscreener_live");
    expect(scoredFromFeatures({ scoreTotal: 75 }, 0.0001, 150_000).marketSource).toBeUndefined();
    // A code this build doesn't know replays as no source rather than a wrong one.
    expect(scoredFromFeatures({ mktSource: 99 }, 0.0001, 150_000).marketSource).toBeUndefined();
    expect(LEARNER_FEATURE_NAMES).toContain("mktSource");
  });

  it("writes the TokenSage markers on every row: read or not, and the writer's rules version", () => {
    const none = buildCandidateFeatures(scored());
    expect(none.nsRead).toBe(0);
    expect(none.nsRulesVersion).toBe(NS_RULES_VERSION);
    expect(none.nsDepthFull).toBeNull();
    expect(LEARNER_FEATURE_NAMES).toContain("nsRead");
    // The version is a handle for masking, never an input.
    expect(RETIRED_LEARNER_INPUTS.has("nsRulesVersion")).toBe(true);
    expect(LEARNER_FEATURE_NAMES).not.toContain("nsRulesVersion");
  });

  it("records Transferred % and the transfer count, learner inputs, null while unread", () => {
    const f = buildCandidateFeatures(scored({ transferredSupplyPct: 3, transferWalletCount: 5 }));
    expect(f.transferredSupplyPct).toBe(3);
    expect(f.transferWalletCount).toBe(5);
    expect(buildCandidateFeatures(scored()).transferredSupplyPct).toBeNull();
    expect(LEARNER_FEATURE_NAMES).toContain("transferredSupplyPct");
    expect(LEARNER_FEATURE_NAMES).toContain("transferWalletCount");
  });

  it("records the launch facts as learner inputs, null while unread", () => {
    const f = buildCandidateFeatures(
      scored({
        tradeFlow: { ...EMPTY_TRADE_FLOW, firstBuyersSeen: 9, firstBuyersHoldingCut: 4 },
        preBondSeconds: 42,
        relaunchSiblings: 3,
        relaunchSiblingPeakMcapUsd: 80_000,
      }),
    );
    expect(f).toMatchObject({
      firstBuyersSeen: 9,
      firstBuyersHoldingCut: 4,
      preBondSeconds: 42,
      relaunchSiblings: 3,
      relaunchSiblingPeakMcapUsd: 80_000,
    });
    const none = buildCandidateFeatures(scored());
    for (const name of LAUNCH_FACT_FEATURES) {
      expect(none[name]).toBeNull();
      expect(LEARNER_FEATURE_NAMES).toContain(name);
    }
    expect(RETIRED_LEARNER_INPUTS.has("firstBuyersHolding")).toBe(true);
  });

  it("records the newest buyers' Wallet Score as learner inputs, unknown without it", () => {
    const f = buildCandidateFeatures(
      scored({ walletScoreRecentBuyersMean: -1.25, walletScoreRecentBuyersScored: 31 }),
    );
    expect(f).toMatchObject({ walletScoreRecentBuyersMean: -1.25, walletScoreRecentBuyersScored: 31 });
    const none = buildCandidateFeatures(scored());
    for (const name of WALLET_SCORE_FEATURES) {
      expect(none[name]).toBeNull();
      expect(LEARNER_FEATURE_NAMES).toContain(name);
    }
  });

  it("records the clean winners' reading of the newest buyers, read by Winners alone, unknown without it", () => {
    const f = buildCandidateFeatures(
      scored({
        cleanWinnerRecentBuyers: 3,
        cleanWinnerRecentShare: 0.06,
        cleanWinnerBuySolShare: 0.12,
        recentBuyersOwn2xMean: 0.041,
        recentBuyersRead: 50,
        cleanWinnerConvictionMax: 2.5,
        cleanWinnerNetShare: 0.02,
        cleanWinnerSellerShare: 0.1,
      }),
    );
    expect(f).toMatchObject({
      cleanWinnerRecentBuyers: 3,
      cleanWinnerRecentShare: 0.06,
      cleanWinnerBuySolShare: 0.12,
      recentBuyersOwn2xMean: 0.041,
      recentBuyersRead: 50,
      cleanWinnerConvictionMax: 2.5,
      cleanWinnerNetShare: 0.02,
      cleanWinnerSellerShare: 0.1,
    });
    const none = buildCandidateFeatures(scored());
    for (const name of WINNER_FOLLOW_FEATURES) {
      expect(none[name]).toBeNull();
      expect(RETIRED_LEARNER_INPUTS.has(name)).toBe(true);
    }
  });

  it("the models read the creator share and the bundles with transfers counted, as the snapshot does", () => {
    const f = buildCandidateFeatures(
      scored({
        linkedCreatorPct: 9,
        linkedCreatorPctExTransfers: 2,
        kolBundledPct: 12,
        kolBundledPctModel: 10,
        kolBundledPctExTransfers: 5,
        bundledSupplyPct: 14,
        bundledSupplyPctModel: 11,
        bundledSupplyPctExTransfers: 7,
      }),
    );
    expect(f).toMatchObject({ linkedCreatorPct: 9, kolBundledPct: 12, bundledSupplyPct: 14 });
    // No fallback to the funding-only or Model copies: unknown without the figure itself.
    const bare = buildCandidateFeatures(
      scored({
        linkedCreatorPctExTransfers: 2,
        kolBundledPctModel: 10,
        kolBundledPctExTransfers: 5,
        bundledSupplyPctModel: 11,
        bundledSupplyPctExTransfers: 7,
      }),
    );
    expect(bare).toMatchObject({ linkedCreatorPct: null, kolBundledPct: null, bundledSupplyPct: null });
  });

  it("rows banked before the short-window capture replay those fields as unknown", () => {
    const legacyFeatures = { volumeToMcapRatio: 1.3, buys24h: 700, sells24h: 300, scoreTotal: 75 };
    const replayed = scoredFromFeatures(legacyFeatures, 0.0001, 150_000);
    expect(replayed.buys1h).toBeUndefined();
    expect(replayed.priceChange5mPct).toBeUndefined();
    // The gate's fallback then judges buy pressure on the 24h window, exactly as it did when
    // the row was banked.
    expect(replayed.buys24h).toBe(700);
  });
});

describe("buildCandidateFeatures - audit additions", () => {
  const base = {
    mintAddress: "m",
    priceUsd: 1,
    marketCapUsd: 100_000,
    narrativeTags: [],
    rugScreen: { passed: true, reasons: [] },
    score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
  };

  it("derives the size ratios and discovery flags", () => {
    const f = buildCandidateFeatures({
      ...base,
      liquidityUsd: 20_000,
      volume5mUsd: 5_000,
      dexBoosted: true,
      description: "  ",
      holderGrowth10mPct: 12,
      minutesSinceFirstInBand: 30,
    });
    expect(f.liquidityToMcapRatio).toBeCloseTo(0.2);
    expect(f.volume5mToMcapRatio).toBeCloseTo(0.05);
    expect(f.dexBoosted).toBe(1);
    expect(f.hasDescription).toBe(0);
    expect(f.holderGrowth10mPct).toBe(12);
    expect(f.minutesSinceFirstInBand).toBe(30);
  });

  it("leaves them null when the inputs were never seen", () => {
    const f = buildCandidateFeatures(base);
    expect(f.liquidityToMcapRatio).toBeNull();
    expect(f.dexBoosted).toBeNull();
    expect(f.hasDescription).toBeNull();
  });

  it("stores an unread social as missing, a read one as 0/1, and replays it the same way", () => {
    // Token.hasTwitter / hasWebsite null = never read (2026-10-16 data audit): never a 0.
    const unread = buildCandidateFeatures(base);
    expect(unread.hasTwitter).toBeNull();
    expect(unread.hasWebsite).toBeNull();
    const none = buildCandidateFeatures({ ...base, hasTwitter: false, hasWebsite: false });
    expect(none.hasTwitter).toBe(0);
    expect(none.hasWebsite).toBe(0);
    const linked = buildCandidateFeatures({ ...base, hasTwitter: true, hasWebsite: true });
    expect(linked.hasTwitter).toBe(1);
    expect(linked.hasWebsite).toBe(1);
    // The Rules replay reads the stored vector back through scoredFromFeatures: missing stays
    // unknown, so a replayed decision sees what the live one saw.
    expect(scoredFromFeatures(unread, 1, 100_000).hasTwitter).toBeUndefined();
    expect(scoredFromFeatures(none, 1, 100_000).hasTwitter).toBe(false);
    expect(scoredFromFeatures(linked, 1, 100_000).hasWebsite).toBe(true);
  });
});

describe("buildCandidateFeatures - livestream", () => {
  it("records live and viewers, 0 for a coin that isn't live, null when the feed wasn't read", () => {
    const live = buildCandidateFeatures(scored({ livestream: { live: true, viewers: 42 } }));
    expect(live.livestreamLive).toBe(1);
    expect(live.livestreamViewers).toBe(42);
    const off = buildCandidateFeatures(scored({ livestream: { live: false, viewers: null } }));
    expect(off.livestreamLive).toBe(0);
    expect(off.livestreamViewers).toBe(0);
    const unknown = buildCandidateFeatures(scored({}));
    expect(unknown.livestreamLive).toBeNull();
    expect(unknown.livestreamViewers).toBeNull();
    // Recorded still; the learners read neither (live is viewers > 0, 2026-10-15; the viewer
    // count was 0 on every decision row, 2026-10-18).
    expect(LEARNER_FEATURE_NAMES).not.toContain("livestreamLive");
    expect(LEARNER_FEATURE_NAMES).not.toContain("livestreamViewers");
    expect(scoredFromFeatures(live, 1, 100_000).livestream).toEqual({ live: true, viewers: 42 });
    expect(scoredFromFeatures(unknown, 1, 100_000).livestream).toBeUndefined();
  });
});

describe("buildCandidateFeatures - fresh quote", () => {
  it("records the gap to DexScreener's price and Jupiter's activity, all null without a quote", () => {
    const f = buildCandidateFeatures(
      scored({
        priceUsd: 0.0001,
        marketCapUsd: 100_000,
        freshQuote: {
          priceUsd: 0.00013,
          // Jupiter's own figure, on a post-burn supply: the ratio uses DexScreener's (130,000).
          marketCapUsd: 118_820,
          fetchedAt: new Date(),
          stats5m: {
            priceChangePct: 25,
            buyVolumeUsd: 9_000,
            sellVolumeUsd: 3_000,
            traders: 50,
            netBuyers: 12,
          },
          stats1h: { priceChangePct: 140, holderChange: 90 },
          holderCount: 412,
        },
      }),
    );
    expect(f.freshGapPct).toBeCloseTo(30);
    expect(f.jup5mPriceChangePct).toBe(25);
    expect(f.jup1hPriceChangePct).toBe(140);
    expect(f.jup5mBuyVolumeShare).toBeCloseTo(0.75);
    expect(f.jup5mVolumeToMcap).toBeCloseTo(12_000 / 130_000);
    // The window was reported, so missing counts are zero trades; the holder change was not.
    expect(f.jup5mBuys).toBe(0);
    expect(f.jup5mHolderChange).toBeNull();
    expect(f.jup1hHolderChange).toBe(90);
    expect(LEARNER_FEATURE_NAMES).toContain("freshGapPct");
    // Jupiter's holder count is read in place of RugCheck's (data-correctness audit 2026-10-16).
    expect(f.jupHolderCount).toBe(412);
    expect(LEARNER_FEATURE_NAMES).toContain("jupHolderCount");
    expect(LEARNER_FEATURE_NAMES).not.toContain("holderCount");

    const none = buildCandidateFeatures(scored({}));
    for (const k of [
      "freshGapPct",
      "jup5mPriceChangePct",
      "jup5mBuys",
      "jup5mBuyVolumeShare",
      "jupHolderCount",
    ] as const) {
      expect(none[k]).toBeNull();
    }
  });
});

describe("withCurrentNarrativeTiming", () => {
  it("reads TokenSage inputs as missing on rows from before the read arrived at decision time", () => {
    const old = {
      anchorAt: new Date("2026-10-08T18:09:59Z"),
      features: { nsCopycat: 1, nsDepthFull: 0, nsLogoScore: null, mcapUsd: 50_000, hasTwitter: 1 },
      labelValue: 1,
    };
    const fresh = { ...old, anchorAt: NARRATIVE_READ_AT_DECISION_SINCE };
    const noRead = { ...old, features: { mcapUsd: 40_000 } };
    const [maskedOld, keptFresh, keptNoRead] = withCurrentNarrativeTiming([old, fresh, noRead]);
    expect(maskedOld).toEqual({
      ...old,
      features: { nsCopycat: null, nsDepthFull: null, nsLogoScore: null, mcapUsd: 50_000, hasTwitter: 1 },
    });
    expect(old.features.nsCopycat).toBe(1);
    expect(keptFresh).toBe(fresh);
    expect(keptNoRead).toBe(noRead);
  });
});

describe("isPreFeeWalletStonksRow", () => {
  it("leaves out Stonks rows banked before the fee wallet left their holders, and nothing else", () => {
    const before = new Date(STONKS_FEE_WALLET_EXCLUDED_SINCE.getTime() - 1);
    expect(isPreFeeWalletStonksRow(before, { launchpadStonks: 1 })).toBe(true);
    expect(isPreFeeWalletStonksRow(STONKS_FEE_WALLET_EXCLUDED_SINCE, { launchpadStonks: 1 })).toBe(false);
    expect(isPreFeeWalletStonksRow(before, { launchpadStonks: 0 })).toBe(false);
    expect(isPreFeeWalletStonksRow(before, { launchpadStonks: null })).toBe(false);
    expect(isPreFeeWalletStonksRow(before, {})).toBe(false);
  });
});

describe("withLaunchAge", () => {
  const before = new Date(AGE_FROM_LAUNCH_SINCE.getTime() - 60 * 60_000);
  const poolAged = { graduated: 1, ageMinutes: 2, pairAgeMinutes: 2.4, mcapUsd: 50_000 };

  it("rebuilds an older graduated row's age from the launch", () => {
    const launchedAt = new Date(before.getTime() - 200 * 60_000);
    expect(ageMayBePoolAge(before, poolAged)).toBe(true);
    const rebuilt = withLaunchAge(before, poolAged, launchedAt);
    expect(rebuilt).toEqual({ ...poolAged, ageMinutes: 200 });
    expect(poolAged.ageMinutes).toBe(2);
  });

  it("drops a pool-aged row with no launch time, and masks the age it can't tell", () => {
    expect(withLaunchAge(before, poolAged, null)).toBeNull();
    const notPool = { ...poolAged, ageMinutes: 40 };
    expect(withLaunchAge(before, notPool, null)).toEqual({ ...notPool, ageMinutes: null });
    const noPairAge = { graduated: 1, ageMinutes: 2 };
    expect(withLaunchAge(before, noPairAge, undefined)).toEqual({ ...noPairAge, ageMinutes: null });
  });

  it("leaves curve rows, marked rows and rows since the change as they are", () => {
    const launchedAt = new Date(before.getTime() - 200 * 60_000);
    const curve = { ...poolAged, graduated: 0 };
    expect(withLaunchAge(before, curve, launchedAt)).toBe(curve);
    const marked = { ...poolAged, ageSource: 0 };
    expect(withLaunchAge(before, marked, launchedAt)).toBe(marked);
    expect(withLaunchAge(AGE_FROM_LAUNCH_SINCE, poolAged, null)).toBe(poolAged);
  });
});

describe("maskKnownBadInputs", () => {
  it("reads the creator share and the bundle figures as missing on every row banked before they counted transfers", () => {
    const row = {
      linkedCreatorPct: 4,
      kolBundledPct: 0,
      bundledSupplyPct: 9,
      linkedWalletPct: 9,
      mcapUsd: 50_000,
    };
    const masked = { ...row, linkedCreatorPct: null, kolBundledPct: null, bundledSupplyPct: null };
    const { from, until } = HOLDER_TRANSFER_LINKS_WINDOW;
    // Funding only before the window, transfer-linked without the KOL sends in it, funding only after.
    expect(maskKnownBadInputs(new Date(from.getTime() - 1), row)).toEqual(masked);
    expect(maskKnownBadInputs(from, row)).toEqual(masked);
    expect(maskKnownBadInputs(until, row)).toEqual(masked);
    expect(maskKnownBadInputs(new Date(HOLDER_TRANSFER_LINKS_READ_SINCE.getTime() - 1), row)).toEqual(masked);
    expect(maskKnownBadInputs(HOLDER_TRANSFER_LINKS_READ_SINCE, row)).toBe(row);
    expect(row.linkedCreatorPct).toBe(4);
  });
  it("reads a backfilled bundledSupplyPct as missing with the rest, alongside the older masks", () => {
    const rebuilt = { bundledSupplyPct: 6, kolBundledPct: 3, linkedWalletPct: 3, mcapUsd: 50_000 };
    expect(maskKnownBadInputs(BUNDLED_SUPPLY_POINT_IN_TIME_FROM, rebuilt)).toEqual({
      ...rebuilt,
      bundledSupplyPct: null,
      kolBundledPct: null,
    });
    expect(rebuilt.bundledSupplyPct).toBe(6);
    expect(maskKnownBadInputs(new Date("2026-10-04T12:00:00Z"), { ...rebuilt, hasTwitter: 1 })).toMatchObject(
      {
        bundledSupplyPct: null,
        kolBundledPct: null,
        hasTwitter: null,
        linkedWalletPct: 3,
      },
    );
  });

  it("reads the fake order-flow zeros on old rows as missing, and leaves newer rows alone", () => {
    const row = {
      uniqueBuyers5m: 0,
      tradesPerMin5m: 0,
      devInitialBuySol: 1.5,
      firstBuyersHolding: 0,
      hasTwitter: 1,
      mcapUsd: 50_000,
    };
    const masked = maskKnownBadInputs(new Date("2026-10-04T12:00:00Z"), row);
    expect(masked).toMatchObject({
      uniqueBuyers5m: null,
      tradesPerMin5m: null,
      firstBuyersHolding: null,
      hasTwitter: null,
      devInitialBuySol: 1.5,
      mcapUsd: 50_000,
    });
    expect(row.uniqueBuyers5m).toBe(0);
    const fresh = maskKnownBadInputs(PATH_TAPE_REFILL_SINCE, row);
    expect(fresh).toBe(row);
  });

  it("reads the social bits as missing on rows from before they came from discovery, keeping the flow", () => {
    const row = { hasTwitter: 1, hasTelegram: 0, hasWebsite: 1, uniqueBuyers5m: 3, mcapUsd: 50_000 };
    const masked = maskKnownBadInputs(TRADE_FLOW_FAKE_ZEROS_UNTIL, row);
    expect(masked).toEqual({
      hasTwitter: null,
      hasTelegram: null,
      hasWebsite: null,
      uniqueBuyers5m: 3,
      mcapUsd: 50_000,
    });
    expect(maskKnownBadInputs(new Date("2026-10-07T19:38:59Z"), row).hasTwitter).toBeNull();
    expect(maskKnownBadInputs(SOCIAL_BITS_FROM_DISCOVERY_SINCE, row)).toEqual(row);
  });

  it("reads the fresh-price gap and market base rates as missing before live fresh quotes", () => {
    const row = { freshGapPct: -12, mktBaseRate1hPct: 8, mktBaseRate6hPct: 9, mcapUsd: 50_000 };
    expect(maskKnownBadInputs(new Date("2026-10-12T16:02:59Z"), row)).toEqual({
      freshGapPct: null,
      mktBaseRate1hPct: null,
      mktBaseRate6hPct: null,
      mcapUsd: 50_000,
    });
    expect(maskKnownBadInputs(FRESH_QUOTE_GAP_SINCE, row)).toEqual(row);
  });

  it("reads path inputs as missing before the tape refill when the tape is shorter than the coin's age", () => {
    const at = new Date("2026-10-13T01:04:00Z");
    const short = { ageMinutes: 40, pathObservedMinutes: 4, pathRet15mPct: 20, pathRet5mPct: 5, mcapUsd: 1 };
    expect(maskKnownBadInputs(at, short)).toMatchObject({
      pathRet15mPct: null,
      pathRet5mPct: null,
      pathObservedMinutes: 4,
    });
    const full = { ageMinutes: 40, pathObservedMinutes: 30, pathRet15mPct: 20 };
    expect(maskKnownBadInputs(at, full).pathRet15mPct).toBe(20);
    const young = { ageMinutes: 3, pathObservedMinutes: 2.5, pathRet1mPct: 4 };
    expect(maskKnownBadInputs(at, young).pathRet1mPct).toBe(4);
    expect(maskKnownBadInputs(PATH_TAPE_REFILL_SINCE, short).pathRet5mPct).toBe(5);
  });

  it("reads the 15 and 30-minute returns as missing before they spanned gaps when the tape was short of the window", () => {
    const at = new Date("2026-10-16T18:59:59Z");
    // Tape under 15 minutes on a 40-minute coin: both returns go; the rest of the block stays.
    const short = {
      ageMinutes: 40,
      pathObservedMinutes: 12,
      pathRet5mPct: 5,
      pathRet15mPct: 20,
      pathRet30mPct: 25,
      pathDrawdown15mPct: -3,
      pathGapMinutes: 18,
      mcapUsd: 1,
    };
    expect(maskKnownBadInputs(at, short)).toEqual({ ...short, pathRet15mPct: null, pathRet30mPct: null });
    expect(short.pathRet15mPct).toBe(20);
    // Tape past 15 but short of 30: only the 30-minute return goes.
    const mid = { ...short, pathObservedMinutes: 20 };
    expect(maskKnownBadInputs(at, mid)).toEqual({ ...mid, pathRet30mPct: null });
    // A full tape, or a coin younger than the window the tape has followed from birth, keeps both.
    expect(maskKnownBadInputs(at, { ...short, pathObservedMinutes: 29.5 })).toEqual({
      ...short,
      pathObservedMinutes: 29.5,
    });
    const young = { ...short, ageMinutes: 10, pathObservedMinutes: 9.5 };
    expect(maskKnownBadInputs(at, young)).toBe(young);
    // The slack: a tape a few seconds short of the window still counts as covering it.
    expect(maskKnownBadInputs(at, { ...mid, pathObservedMinutes: 29.2 }).pathRet30mPct).toBe(25);
    // Rows since carry returns measured across the gap, read as they are.
    expect(maskKnownBadInputs(PATH_RETURNS_ACROSS_GAPS_SINCE, short)).toBe(short);
  });

  it("reads the sniper share as missing before closed accounts left the top 10", () => {
    const row = { sniperTop10WalletPct: 40, freshGapPct: 2, mcapUsd: 1 };
    expect(maskKnownBadInputs(new Date("2026-10-12T18:16:59Z"), row).sniperTop10WalletPct).toBeNull();
    expect(maskKnownBadInputs(new Date("2026-10-12T18:16:59Z"), row).freshGapPct).toBe(2);
    expect(maskKnownBadInputs(SNIPER_SHARE_CLOSED_ACCOUNTS_DROPPED_SINCE, row).sniperTop10WalletPct).toBe(40);
  });

  it("reads hasTwitter and hasWebsite as missing while Pump.fun's coin list was blocked", () => {
    // A 1 is a real read, kept outside the outage; a 0 reads as missing until #678 anyway.
    const row = { hasTwitter: 1, hasTelegram: 0, hasWebsite: 0, freshGapPct: 2 };
    expect(maskKnownBadInputs(new Date("2026-10-15T01:00:00Z"), row)).toEqual({
      hasTwitter: null,
      hasTelegram: 0,
      hasWebsite: null,
      freshGapPct: 2,
    });
    const outsideOutage = { ...row, hasWebsite: null };
    expect(maskKnownBadInputs(SOCIAL_LIST_OUTAGE.until, row)).toEqual(outsideOutage);
    expect(maskKnownBadInputs(new Date("2026-10-14T20:59:00Z"), row)).toEqual(outsideOutage);
  });

  it("reads a 0 social bit as missing before unread socials were stored as null (#678), keeping a 1", () => {
    const row = { hasTwitter: 0, hasTelegram: 0, hasWebsite: 1, mcapUsd: 50_000 };
    const before = new Date(SOCIALS_UNREAD_NULL_SINCE.getTime() - 1);
    expect(maskKnownBadInputs(before, row)).toEqual({ ...row, hasTwitter: null });
    expect(maskKnownBadInputs(SOCIALS_UNREAD_NULL_SINCE, row)).toBe(row);
  });

  it("reads the raw-score walletRiskTop10Max as missing on rows without the scored-holder count", () => {
    const raw = { walletRiskTop10Max: 60, walletRiskFirstBuyersMean: 40, mcapUsd: 50_000 };
    const before = new Date(WALLET_RISK_PERCENTILE_SINCE.getTime() - 1);
    expect(isRawWalletRiskRow(before, raw)).toBe(true);
    expect(maskKnownBadInputs(before, raw)).toMatchObject({
      walletRiskTop10Max: null,
      walletRiskFirstBuyersMean: 40,
    });
    // A row carrying the count was already scored as a percentile.
    const percentile = { ...raw, walletRiskScoredTop10: 6 };
    expect(isRawWalletRiskRow(before, percentile)).toBe(false);
    expect(maskKnownBadInputs(before, percentile)).toMatchObject({ walletRiskTop10Max: 60 });
    expect(maskKnownBadInputs(WALLET_RISK_PERCENTILE_SINCE, raw)).toBe(raw);
  });

  it("reads emptyTop10WalletPct as missing before unpriced holdings made it unknown (#678)", () => {
    const row = { emptyTop10WalletPct: 70, mcapUsd: 50_000 };
    const before = new Date(EMPTY_WALLETS_UNPRICED_NULL_SINCE.getTime() - 1);
    expect(maskKnownBadInputs(before, row)).toEqual({ ...row, emptyTop10WalletPct: null });
    expect(maskKnownBadInputs(EMPTY_WALLETS_UNPRICED_NULL_SINCE, row)).toBe(row);
  });

  it("reads volumeAccel's by-construction 12 on young tokens and the 30-second pathRet1mPct as missing before #138", () => {
    const young = { ageMinutes: 2, volumeAccel: 12, pathRet1mPct: 8, mcapUsd: 50_000 };
    const older = { ageMinutes: 30, volumeAccel: 3.5, pathRet1mPct: -4, mcapUsd: 50_000 };
    const before = new Date("2026-10-05T15:29:00Z");
    expect(maskKnownBadInputs(before, young)).toMatchObject({
      volumeAccel: null,
      pathRet1mPct: null,
      ageMinutes: 2,
    });
    expect(maskKnownBadInputs(before, older)).toMatchObject({ volumeAccel: 3.5, pathRet1mPct: null });
    const after = maskKnownBadInputs(VOLUME_ACCEL_YOUNG_NULL_SINCE, young);
    expect(after).toMatchObject({ volumeAccel: 12, pathRet1mPct: 8 });
  });

  it("reads ctxWeekend as missing on the first evening of data, its only weekend rows", () => {
    const row = { ctxWeekend: 1, ctxHourSin: 0.5, mcapUsd: 50_000 };
    expect(maskKnownBadInputs(new Date("2026-10-04T21:00:00Z"), row)).toMatchObject({
      ctxWeekend: null,
      ctxHourSin: 0.5,
    });
    expect(maskKnownBadInputs(WEEKEND_FLAG_FROM, row).ctxWeekend).toBe(1);
  });

  it("reads the waited-for inputs as missing on hourly rows banked before the hourly wait, and nowhere else", () => {
    const row = {
      nsXRead: 1,
      nsXFit: 0.8,
      nsXLikes: 12,
      nsCopycat: 1,
      nsDepthFull: 1,
      freshTop10WalletPct: 20,
      emptyTop10WalletPct: 10,
      sniperTop10WalletPct: 30,
      linkedCreatorPct: 5,
      linkedWalletCount: 2,
      cexFundedPct: 40,
      cexFundedCount: 8,
      bundledSupplyPct: 3,
      kolBundledPct: 0,
      transferredSupplyPct: 1,
      top10HolderPct: 25,
      mcapUsd: 50_000,
      hasTwitter: 1,
      nsRulesVersion: NS_RULES_VERSION,
    };
    const before = new Date(HOURLY_ROWS_WAIT_SINCE.getTime() - 1);
    const masked = maskKnownBadInputs(before, row, "hourly");
    expect(masked).toEqual({
      ...row,
      nsXRead: null,
      nsXFit: null,
      nsXLikes: null,
      freshTop10WalletPct: null,
      emptyTop10WalletPct: null,
      sniperTop10WalletPct: null,
      linkedCreatorPct: null,
      linkedWalletCount: null,
      cexFundedPct: null,
      cexFundedCount: null,
      bundledSupplyPct: null,
      kolBundledPct: null,
      transferredSupplyPct: null,
    });
    expect(row.nsXRead).toBe(1);
    // The quick read, the holder share and the social bits are as they were.
    expect(masked).toMatchObject({ nsCopycat: 1, nsDepthFull: 1, top10HolderPct: 25, hasTwitter: 1 });
    // A decision row of the same moment, an hourly row since the wait, and a call without the
    // kind (the older callers) lose only what the transfer-links window takes (its own test).
    // Before #678 the empty-wallet share reads as missing too (its own test).
    const transferLinked = { ...row, linkedCreatorPct: null, kolBundledPct: null, bundledSupplyPct: null };
    const beforeUnpriced = { ...transferLinked, emptyTop10WalletPct: null };
    expect(maskKnownBadInputs(before, row, "event")).toEqual(beforeUnpriced);
    expect(maskKnownBadInputs(HOURLY_ROWS_WAIT_SINCE, row, "hourly")).toEqual(transferLinked);
    expect(maskKnownBadInputs(before, row)).toEqual(beforeUnpriced);
    // Together with the older masks on a row old enough for both.
    const oldest = maskKnownBadInputs(new Date("2026-10-07T12:00:00Z"), row, "hourly");
    expect(oldest).toMatchObject({ hasTwitter: null, nsXRead: null, nsCopycat: 1 });
  });

  it("reads the TokenSage inputs as missing on rows from before the rules marker that carry no version", () => {
    // A row from the #631 era: ns* inputs written under rules nobody can name.
    const row = {
      nsCopycat: 1,
      nsDepthFull: 1,
      nsXRead: 0,
      nsLogoScore: null,
      mcapUsd: 50_000,
      hasTwitter: 1,
    };
    const before = new Date("2026-10-16T18:59:59Z");
    expect(maskKnownBadInputs(before, row)).toEqual({
      nsCopycat: null,
      nsDepthFull: null,
      nsXRead: null,
      nsLogoScore: null,
      mcapUsd: 50_000,
      hasTwitter: 1,
    });
    expect(row.nsCopycat).toBe(1);
    // The trainer's fixed shape fills a missing input with undefined, which is also "no version".
    expect(maskKnownBadInputs(before, { ...row, nsRulesVersion: undefined }).nsCopycat).toBeNull();
    // A row from the marker on carries its version and is read as stored, same object.
    const versioned = { ...row, nsRulesVersion: NS_RULES_VERSION, nsRead: 1 };
    expect(maskKnownBadInputs(NS_RULES_VERSION_MARKER_SINCE, versioned)).toBe(versioned);
    // A pre-marker row with the current rules version is still read.
    expect(maskKnownBadInputs(before, versioned)).toBe(versioned);
    // A row stamped with an older writer version is masked like the pre-marker era.
    expect(maskKnownBadInputs(before, { ...versioned, nsRulesVersion: 0 }).nsCopycat).toBeNull();
    // Nothing to mask on a row without TokenSage inputs: same object.
    const noRead = { mcapUsd: 40_000, hasTwitter: 1 };
    expect(maskKnownBadInputs(before, noRead)).toBe(noRead);
  });

  it("masks the TokenSage inputs together with the older eras' inputs on one row", () => {
    const row = { nsCopycat: 1, hasTwitter: 1, uniqueBuyers5m: 0, mcapUsd: 50_000 };
    expect(maskKnownBadInputs(new Date("2026-10-04T12:00:00Z"), row)).toEqual({
      nsCopycat: null,
      hasTwitter: null,
      uniqueBuyers5m: null,
      mcapUsd: 50_000,
    });
  });

  it("keeps the retired duplicates off the learner list", () => {
    for (const name of ["nsReferentNamed", "nsXContentMismatch"] as const) {
      expect(LEARNER_FEATURE_NAMES).not.toContain(name);
    }
    expect(LEARNER_FEATURE_NAMES).toContain("devInitialBuySol");
  });
});

describe("the market seats' TokenSage inputs", () => {
  it("keeps the fee group and logo score, and leaves the rest to the Narrative seats", () => {
    for (const name of MARKET_TOKENSAGE_INPUTS) expect(MARKET_LEARNER_FEATURE_NAMES).toContain(name);
    expect(MARKET_LEARNER_FEATURE_NAMES).not.toContain("nsCatAnimal");
    expect(MARKET_LEARNER_FEATURE_NAMES).not.toContain("nsDepthFull");
    expect(LEARNER_FEATURE_NAMES).toContain("nsCatAnimal");
    expect(MARKET_LEARNER_FEATURE_NAMES.filter((n) => n.startsWith("ns"))).toHaveLength(
      MARKET_TOKENSAGE_INPUTS.length,
    );
    // Every non-TokenSage learner input stays.
    for (const name of LEARNER_FEATURE_NAMES.filter((n) => !n.startsWith("ns"))) {
      expect(MARKET_LEARNER_FEATURE_NAMES).toContain(name);
    }
  });
});
