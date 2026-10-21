import { describe, expect, it } from "vitest";
import { enrichToken } from "./enrich.js";
import type { CandidateToken, OnChainProfile } from "../types.js";

const candidate: CandidateToken = {
  mintAddress: "mint111",
  symbol: "MOON",
  name: "Moon Dog",
  priceUsd: 0.002,
  marketCapUsd: 150_000,
  volume24hUsd: 300_000,
};

const onChain: OnChainProfile = {
  mintAddress: "mint111",
  holderCount: 220,
  top10HolderPct: 20,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  lpBurned: true,
};

describe("enrichToken", () => {
  it("computes volumeToMcapRatio", () => {
    const enriched = enrichToken(candidate, onChain);
    expect(enriched.volumeToMcapRatio).toBeCloseTo(2);
  });

  it("computes ageMinutes from a provided createdAt", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const createdAt = new Date("2026-01-01T00:30:00Z");
    const enriched = enrichToken(candidate, onChain, { now, createdAt });
    expect(enriched.ageMinutes).toBe(30);
  });

  it("counts the age from the launch when a launch source said, over the pool's age", () => {
    const now = new Date("2026-01-01T02:00:00Z");
    // The scan met the coin at its PumpSwap pool: every anchor it has is the graduation.
    const poolCreatedAt = new Date("2026-01-01T01:59:00Z");
    const launchedAt = new Date("2026-01-01T00:30:00Z");
    const graduate = { ...candidate, dexId: "pumpswap", pairCreatedAt: poolCreatedAt };
    const fromPool = enrichToken(graduate, onChain, { now, createdAt: poolCreatedAt });
    expect(fromPool.ageMinutes).toBe(1);
    expect(fromPool.ageFromLaunch).toBe(false);
    const fromLaunch = enrichToken(graduate, onChain, { now, createdAt: poolCreatedAt, launchedAt });
    expect(fromLaunch.ageMinutes).toBe(90);
    expect(fromLaunch.ageFromLaunch).toBe(true);
    // An unreadable launch time counts for nothing; no anchor at all means no age, not "pool".
    expect(enrichToken(graduate, onChain, { now, launchedAt: new Date(NaN) })).toMatchObject({
      ageMinutes: 1,
      ageFromLaunch: false,
    });
    const unknown = enrichToken({ ...candidate, pairCreatedAt: undefined }, onChain, { now });
    expect(unknown.ageMinutes).toBeUndefined();
    expect(unknown.ageFromLaunch).toBeUndefined();
  });

  it("keeps sub-minute ages, so a fractional filter bound can act on them", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fifteenSeconds = new Date(now.getTime() - 15_000);
    const enriched = enrichToken(candidate, onChain, { now, createdAt: fifteenSeconds });
    // 0.25, not 0: rounding this to a whole minute is what used to make "min age 0.25" a no-op.
    expect(enriched.ageMinutes).toBe(0.25);
  });

  it("distinguishes two tokens that used to collapse to the same whole minute", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const young = enrichToken(candidate, onChain, { now, createdAt: new Date(now.getTime() - 15_000) });
    const older = enrichToken(candidate, onChain, { now, createdAt: new Date(now.getTime() - 40_000) });
    expect(young.ageMinutes).not.toBe(older.ageMinutes);
    expect(young.ageMinutes! < 0.5 && older.ageMinutes! > 0.5).toBe(true);
  });

  it("leaves ageMinutes undefined when no creation time is known", () => {
    const enriched = enrichToken(candidate, onChain);
    expect(enriched.ageMinutes).toBeUndefined();
  });

  it("computes holderGrowthPct when a previous holder count is given", () => {
    const enriched = enrichToken(candidate, onChain, { previousHolderCount: 200 });
    expect(enriched.holderGrowthPct).toBeCloseTo(10);
  });

  it("derives narrative tags from name/symbol", () => {
    const enriched = enrichToken(candidate, onChain);
    expect(enriched.narrativeTags).toContain("dog");
  });

  it("carries through on-chain fields", () => {
    const enriched = enrichToken(candidate, onChain);
    expect(enriched.lpBurned).toBe(true);
    expect(enriched.top10HolderPct).toBe(20);
  });

  it("handles a null on-chain profile gracefully", () => {
    const enriched = enrichToken(candidate, null);
    expect(enriched.lpBurned).toBeUndefined();
    expect(enriched.holderGrowthPct).toBeUndefined();
  });

  it("derives graduated: false for a pump.fun bonding-curve pair", () => {
    const enriched = enrichToken({ ...candidate, dexId: "pumpfun" }, onChain);
    expect(enriched.graduated).toBe(false);
  });

  it("derives graduated: true for any real DEX pair (pumpswap, raydium, ...)", () => {
    expect(enrichToken({ ...candidate, dexId: "pumpswap" }, onChain).graduated).toBe(true);
    expect(enrichToken({ ...candidate, dexId: "raydium" }, onChain).graduated).toBe(true);
  });

  it("leaves graduated undefined when dexId itself is unknown", () => {
    const enriched = enrichToken(candidate, onChain);
    expect(enriched.graduated).toBeUndefined();
  });

  it("computes 10-minute holder growth and time in the band when their baselines are given", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const enriched = enrichToken(candidate, onChain, {
      now,
      previousHolderCount10m: 176,
      firstInBandAt: new Date("2026-01-01T00:15:00Z"),
    });
    expect(enriched.holderGrowth10mPct).toBeCloseTo(25);
    expect(enriched.minutesSinceFirstInBand).toBe(45);
    expect(enrichToken(candidate, onChain).holderGrowth10mPct).toBeUndefined();
  });

  it("leaves holder growth unknown when the baseline and today's count are one report, or minutes apart", () => {
    const readAt = new Date("2026-01-01T00:48:00Z");
    const read = { ...onChain, holderCountAt: readAt };
    // A stale report served again: the 10-minute baseline is the same reading.
    const same = enrichToken(candidate, read, {
      previousHolderCount10m: 220,
      previousHolderCount10mAt: readAt,
      previousHolderCount: 200,
      previousHolderCountAt: new Date("2026-01-01T00:40:00Z"),
      holderGrowthWindowMinutes: 30,
    });
    expect(same.holderGrowth10mPct).toBeUndefined();
    // 8 minutes is under half the 30-minute window too.
    expect(same.holderGrowthPct).toBeUndefined();
    // Readings 6 and 20 minutes apart are real growth.
    const apart = enrichToken(candidate, read, {
      previousHolderCount10m: 176,
      previousHolderCount10mAt: new Date("2026-01-01T00:42:00Z"),
      previousHolderCount: 176,
      previousHolderCountAt: new Date("2026-01-01T00:28:00Z"),
      holderGrowthWindowMinutes: 30,
    });
    expect(apart.holderGrowth10mPct).toBeCloseTo(25);
    expect(apart.holderGrowthPct).toBeCloseTo(25);
  });

  it("leaves an unindexed or too-close holder reading unknown, not 0", () => {
    const readAt = new Date("2026-01-01T00:48:00Z");
    const close = enrichToken(
      candidate,
      { ...onChain, holderCountAt: readAt },
      {
        previousHolderCount: 220,
        previousHolderCountAt: readAt,
        previousHolderCount10m: 220,
        previousHolderCount10mAt: new Date(readAt.getTime() - 4 * 60_000),
        holderGrowthWindowMinutes: 30,
      },
    );
    expect(close.holderGrowthPct).toBeUndefined();
    expect(close.holderGrowth10mPct).toBeUndefined();
    expect(close.holderGrowthPct).not.toBe(0);
    expect(close.holderGrowth10mPct).not.toBe(0);
    // Equal counts with no times: the same report may have been served twice.
    const untimed = enrichToken(candidate, onChain, {
      previousHolderCount: 220,
      previousHolderCount10m: 220,
    });
    expect(untimed.holderGrowthPct).toBeUndefined();
    expect(untimed.holderGrowth10mPct).toBeUndefined();
    // 0 holders is an unindexed list. It is not flat growth and not -100%.
    const unindexed = enrichToken(
      candidate,
      { ...onChain, holderCount: 0, riskScore: 0 },
      {
        previousHolderCount: 200,
        previousHolderCountAt: new Date("2026-01-01T00:00:00Z"),
        previousHolderCount10m: 180,
        previousHolderCount10mAt: new Date("2026-01-01T00:30:00Z"),
        holderGrowthWindowMinutes: 30,
      },
    );
    expect(unindexed.holderCount).toBeUndefined();
    expect(unindexed.holderGrowthPct).toBeUndefined();
    expect(unindexed.holderGrowth10mPct).toBeUndefined();
    expect(unindexed.riskScore).toBeUndefined();
    expect(enrichToken(candidate, null, { previousHolderCount: 200 }).holderGrowthPct).toBeUndefined();
    // Two readings half a window apart that did not change are a real flat.
    const flat = enrichToken(
      candidate,
      { ...onChain, holderCountAt: readAt },
      {
        previousHolderCount: 220,
        previousHolderCountAt: new Date(readAt.getTime() - 20 * 60_000),
        holderGrowthWindowMinutes: 30,
      },
    );
    expect(flat.holderCount).toBe(220);
    expect(flat.holderGrowthPct).toBe(0);
  });
});
