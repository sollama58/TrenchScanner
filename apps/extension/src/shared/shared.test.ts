import { describe, expect, it } from "vitest";
import { chunk, LookupCache, TRACKED_TTL_MS, UNTRACKED_TTL_MS } from "./lookupCache";
import { base58Length, isMintAddress, mintsIn } from "./mint";
import { DEFAULT_SETTINGS } from "./settings";
import { token } from "./testToken";
import type { OverlaySettings } from "./types";
import { verdictFor } from "./verdict";

const MINT = "So11111111111111111111111111111111111111112";
const PUMP = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";

const call = {
  model: "rules",
  name: "Runner A",
  tier: "high",
  confidence: 74,
  calibratedPct: 74.4,
  at: new Date().toISOString(),
  mcapUsd: 6_100,
};
const match = { filterId: "f1", filterName: "Clean launch", at: new Date().toISOString(), mcapUsd: 6_100 };

describe("mint addresses", () => {
  it("accepts only base58 that decodes to 32 bytes", () => {
    expect(base58Length(MINT)).toBe(32);
    expect(isMintAddress(MINT)).toBe(true);
    expect(isMintAddress(PUMP)).toBe(true);
    expect(isMintAddress("GPs…pump")).toBe(false);
    expect(isMintAddress("0OIl".repeat(10))).toBe(false);
    // A transaction signature is base58 too, but 64 bytes and too long.
    expect(isMintAddress("5".repeat(88))).toBe(false);
  });

  it("finds addresses inside URLs without repeats", () => {
    expect(mintsIn(`/sol/token/abc_${PUMP}?x=${PUMP}`)).toEqual([PUMP]);
    expect(mintsIn("/trenches?tab=new")).toEqual([]);
  });
});

describe("row verdicts", () => {
  it("rings model, filter and both, with the model's odds on the badge", () => {
    expect(verdictFor(token({ modelCalls: [call] }), DEFAULT_SETTINGS)).toMatchObject({
      ring: "model",
      badge: "Runner A 74%",
    });
    expect(verdictFor(token({ filterMatches: [match] }), DEFAULT_SETTINGS)).toMatchObject({
      ring: "filter",
      badge: "Clean launch",
    });
    expect(verdictFor(token({ modelCalls: [call], filterMatches: [match] }), DEFAULT_SETTINGS).ring).toBe(
      "both",
    );
    expect(verdictFor(token(), DEFAULT_SETTINGS).ring).toBeNull();
  });

  it("keeps model rings to AI buys when asked, and honours the ring switches", () => {
    const aiOnly: OverlaySettings = {
      ...DEFAULT_SETTINGS,
      rings: { ...DEFAULT_SETTINGS.rings, aiBuyOnly: true },
    };
    expect(verdictFor(token({ modelCalls: [call] }), aiOnly).ring).toBeNull();
    const buy = { decision: "buy", probability2x: 0.6, reasoning: null, at: call.at };
    expect(verdictFor(token({ modelCalls: [call], ai: buy }), aiOnly).ring).toBe("model");
    const noFilters: OverlaySettings = {
      ...DEFAULT_SETTINGS,
      rings: { ...DEFAULT_SETTINGS.rings, filterMatches: false },
    };
    expect(verdictFor(token({ filterMatches: [match] }), noFilters).ring).toBeNull();
  });

  it("grades flags against their limits and rings red only when nothing alerted", () => {
    const risky = token({ stats: { ...token().stats!, bundledSupplyPct: 38, linkedWalletPct: 20 } });
    const v = verdictFor(risky, DEFAULT_SETTINGS);
    expect(v.ring).toBe("risk");
    expect(v.badge).toBe("BNDL 38%");
    expect(v.flags.find((f) => f.id === "bundledSupplyPct")?.level).toBe("hi");
    expect(v.flags.find((f) => f.id === "linkedWalletPct")?.level).toBe("mid");
    // Off by default, so not read.
    expect(v.flags.some((f) => f.id === "devWalletPct")).toBe(false);
    const alerted = verdictFor({ ...risky, modelCalls: [call] }, DEFAULT_SETTINGS);
    expect(alerted).toMatchObject({ ring: "model", risky: true });
    const noRisk: OverlaySettings = {
      ...DEFAULT_SETTINGS,
      rings: { ...DEFAULT_SETTINGS.rings, riskRing: false },
    };
    expect(verdictFor(risky, noRisk).ring).toBeNull();
  });
});

describe("lookup cache", () => {
  it("asks only for what it doesn't know, and remembers untracked mints longer", () => {
    const cache = new LookupCache();
    expect(cache.missing([MINT, PUMP, MINT], 0)).toEqual([MINT, PUMP]);
    cache.store([MINT, PUMP], [token()], 0);
    expect(cache.missing([MINT, PUMP], 1_000)).toEqual([]);
    expect(cache.answer([MINT, PUMP])).toEqual({ [PUMP]: token() });
    expect(cache.missing([MINT, PUMP], TRACKED_TTL_MS)).toEqual([PUMP]);
    expect(cache.missing([MINT, PUMP], UNTRACKED_TTL_MS)).toEqual([MINT, PUMP]);
  });

  it("splits into the API's batch size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
