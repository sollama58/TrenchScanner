import { describe, expect, it } from "vitest";
import type { Token } from "@prisma/client";
import { knownSocial, tokenChanges } from "./scanJob.js";

const existing = {
  symbol: "DOG",
  name: "Dog",
  pairAddress: "pair1",
  imageUrl: "https://img/1.png",
  hasTwitter: true,
  hasTelegram: false,
  hasWebsite: false,
  firstInBandAt: new Date("2026-10-01T00:00:00Z"),
  narrativeTags: ["animal"],
} as unknown as Token;

describe("tokenChanges", () => {
  it("is empty when a re-scan changes nothing, so the row is not rewritten", () => {
    expect(
      tokenChanges(existing, {
        symbol: "DOG",
        name: "Dog",
        pairAddress: "pair1",
        imageUrl: undefined,
        hasTwitter: false,
        hasTelegram: false,
        firstInBandAt: new Date(),
        narrativeTags: ["animal"],
      }),
    ).toEqual({});
  });

  it("carries only what changed, keeping images, socials and firstInBandAt sticky", () => {
    expect(
      tokenChanges(existing, {
        symbol: undefined,
        name: "Dog 2",
        pairAddress: "pair1",
        imageUrl: "https://img/2.png",
        hasTelegram: true,
        narrativeTags: ["animal", "meme"],
      }),
    ).toEqual({
      name: "Dog 2",
      imageUrl: "https://img/2.png",
      hasTelegram: true,
      narrativeTags: ["animal", "meme"],
    });
  });

  it("with no row to compare, sets everything a re-scan may set", () => {
    const at = new Date();
    expect(
      tokenChanges(null, { symbol: "X", hasWebsite: true, firstInBandAt: at, narrativeTags: [] }),
    ).toEqual({
      symbol: "X",
      hasWebsite: true,
      firstInBandAt: at,
      narrativeTags: [],
    });
  });

  it("keeps the last measured wallet readings, never clearing them with an unknown", () => {
    const base = { narrativeTags: ["animal"] };
    const withReadings = { ...existing, lastEmptyTop10WalletPct: 40, lastFreshTop10WalletPct: 10 } as Token;
    expect(tokenChanges(withReadings, { ...base, emptyTop10WalletPct: 40, freshTop10WalletPct: 10 })).toEqual(
      {},
    );
    expect(tokenChanges(withReadings, { ...base, emptyTop10WalletPct: 60 })).toEqual({
      lastEmptyTop10WalletPct: 60,
    });
    expect(tokenChanges(withReadings, base)).toEqual({});
  });
});

describe("knownSocial", () => {
  it("keeps a link the Token row holds when the re-scan's candidate lacks it", () => {
    // DexScreener reports socials for almost nothing in the band; the Token row keeps Pump.fun's.
    expect(knownSocial(false, true)).toBe(true);
    expect(knownSocial(undefined, true)).toBe(true);
    expect(knownSocial(true, false)).toBe(true);
  });

  it("is a known none only when the candidate said so, and unknown otherwise", () => {
    expect(knownSocial(false, false)).toBe(false);
    expect(knownSocial(false, undefined)).toBe(false);
    expect(knownSocial(undefined, false)).toBeUndefined();
    expect(knownSocial(undefined, undefined)).toBeUndefined();
  });
});
