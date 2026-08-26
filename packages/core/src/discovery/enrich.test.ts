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
});
