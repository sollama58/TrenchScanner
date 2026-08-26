import { describe, expect, it } from "vitest";
import { formatDigest, formatRealtimeAlert } from "./alertDispatcher.js";
import type { Token, TokenSnapshot } from "@trenchscanner/core";

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "token-1",
    mintAddress: "MintAddress11111111111111111111111111111",
    symbol: "MOON",
    name: "Moon Dog",
    pairAddress: "Pair1111111111111111111111111111111111111",
    firstSeenAt: new Date(),
    hasTwitter: true,
    hasTelegram: false,
    hasWebsite: false,
    narrativeTags: ["dog"],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    id: "snap-1",
    tokenId: "token-1",
    takenAt: new Date(),
    priceUsd: 0.002,
    marketCapUsd: 180_000,
    liquidityUsd: 40_000,
    volume24hUsd: 320_000,
    volumeToMcapRatio: 1.7,
    buys24h: 500,
    sells24h: 200,
    holderCount: 340,
    holderGrowthPct: 12,
    top10HolderPct: 22,
    devWalletPct: 3,
    riskScore: 20,
    riskFlags: [],
    freshTop10WalletPct: 0,
    graduated: true,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    ageMinutes: 90,
    score: 72,
    scoreMomentum: 75,
    scoreHolderHealth: 68,
    scoreAge: 80,
    scoreNarrative: 65,
    rugScreenPassed: true,
    rugScreenReasons: [],
    ...overrides,
  };
}

describe("formatRealtimeAlert", () => {
  it("includes the token name, symbol, score, and mint address", () => {
    const text = formatRealtimeAlert(makeToken(), makeSnapshot(), 72);
    expect(text).toContain("Moon Dog");
    expect(text).toContain("$MOON");
    expect(text).toContain("72/100");
    expect(text).toContain("MintAddress11111111111111111111111111111");
  });

  it("formats market cap and volume in compact USD", () => {
    const text = formatRealtimeAlert(
      makeToken(),
      makeSnapshot({ marketCapUsd: 180_000, volume24hUsd: 2_500_000 }),
      72,
    );
    expect(text).toContain("$180.0k");
    expect(text).toContain("$2.50M");
  });

  it("escapes HTML-significant characters in the token name", () => {
    const text = formatRealtimeAlert(makeToken({ name: "<script>alert(1)</script>" }), makeSnapshot(), 50);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("falls back to the mint prefix when no name or symbol is set", () => {
    const text = formatRealtimeAlert(makeToken({ name: null, symbol: null }), makeSnapshot(), 50);
    expect(text).toContain("MintAddr");
  });
});

describe("formatDigest", () => {
  it("reports no matches when the list is empty", () => {
    expect(formatDigest([])).toMatch(/no new matches/i);
  });

  it("lists every entry sorted by score descending", () => {
    const text = formatDigest([
      { token: makeToken({ name: "Low Score" }), snapshot: makeSnapshot(), score: 30 },
      { token: makeToken({ name: "High Score" }), snapshot: makeSnapshot(), score: 90 },
    ]);
    const highIndex = text.indexOf("High Score");
    const lowIndex = text.indexOf("Low Score");
    expect(highIndex).toBeGreaterThan(-1);
    expect(lowIndex).toBeGreaterThan(highIndex);
  });

  it("includes the match count in the header", () => {
    const text = formatDigest([
      { token: makeToken(), snapshot: makeSnapshot(), score: 50 },
      { token: makeToken(), snapshot: makeSnapshot(), score: 60 },
    ]);
    expect(text).toContain("2 matches");
  });
});
