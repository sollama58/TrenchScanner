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

  it("writes the quote coin, its symbol going with its mint", () => {
    const row = { ...existing, quoteMint: "USDCmint", quoteSymbol: "USDC" } as unknown as Token;
    const base = { narrativeTags: ["animal"] };
    // Unchanged, or a reading that doesn't say: nothing to write.
    expect(tokenChanges(row, { ...base, quoteMint: "USDCmint", quoteSymbol: "USDC" })).toEqual({});
    expect(tokenChanges(row, base)).toEqual({});
    // A new quote with no symbol (GeckoTerminal) clears the old symbol rather than mislabel it.
    expect(tokenChanges(row, { ...base, quoteMint: "OTHERmint" })).toEqual({
      quoteMint: "OTHERmint",
      quoteSymbol: null,
    });
    // The same quote, now named.
    const unnamed = { ...row, quoteSymbol: null } as unknown as Token;
    expect(tokenChanges(unnamed, { ...base, quoteMint: "USDCmint", quoteSymbol: "USDC" })).toEqual({
      quoteSymbol: "USDC",
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

describe("tokenChanges - DexScreener token info", () => {
  const base = { narrativeTags: ["animal"] };

  it("sticks once a pair has an info block, and a reading without one leaves it", () => {
    expect(tokenChanges(existing, { ...base, dexInfo: true })).toEqual({ dexInfo: true });
    expect(tokenChanges({ ...existing, dexInfo: true } as Token, { ...base, dexInfo: true })).toEqual({});
    expect(tokenChanges({ ...existing, dexInfo: true } as Token, base)).toEqual({});
    expect(tokenChanges(existing, base)).toEqual({});
  });
});

describe("knownSocial", () => {
  it("keeps a link the Token row holds when the re-scan's candidate lacks it", () => {
    // DexScreener reports socials for almost nothing in the band; the Token row keeps Pump.fun's.
    expect(knownSocial(false, true)).toBe(true);
    expect(knownSocial(undefined, true)).toBe(true);
    expect(knownSocial(true, false)).toBe(true);
  });

  it("is a known none when the candidate or the row read one, and unknown when neither has read", () => {
    expect(knownSocial(false, false)).toBe(false);
    expect(knownSocial(false, undefined)).toBe(false);
    expect(knownSocial(false, null)).toBe(false);
    // A stored false is a read since 2026-10-16; null is the row that no source has read.
    expect(knownSocial(undefined, false)).toBe(false);
    expect(knownSocial(undefined, null)).toBeUndefined();
    expect(knownSocial(undefined, undefined)).toBeUndefined();
  });
});

describe("tokenChanges - socials on a row no source has read", () => {
  const unread = { ...existing, hasTwitter: null, hasWebsite: null } as unknown as Token;
  const base = { narrativeTags: ["animal"] };

  it("settles the row to a read none, and adds a link, but never clears one", () => {
    expect(tokenChanges(unread, { ...base, hasTwitter: false, hasWebsite: true })).toEqual({
      hasTwitter: false,
      hasWebsite: true,
    });
    expect(tokenChanges({ ...existing, hasTwitter: true } as Token, { ...base, hasTwitter: false })).toEqual(
      {},
    );
    expect(tokenChanges({ ...existing, hasWebsite: false } as Token, { ...base, hasWebsite: false })).toEqual(
      {},
    );
  });

  it("leaves it unread when the re-scan's candidate carried no socials either", () => {
    expect(tokenChanges(unread, base)).toEqual({});
  });

  it("fills a missing link from the reading, and never replaces a stored one", () => {
    const linked = {
      ...existing,
      twitterUrl: "https://x.com/kept",
      telegramUrl: null,
      websiteUrl: null,
    } as Token;
    expect(
      tokenChanges(linked, {
        ...base,
        twitterUrl: "https://x.com/new",
        telegramUrl: "https://t.me/dog",
      }),
    ).toEqual({ telegramUrl: "https://t.me/dog" });
    expect(tokenChanges(linked, base)).toEqual({});
  });
});
