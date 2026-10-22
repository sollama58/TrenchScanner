import { describe, expect, it } from "vitest";
import {
  DEX_INFO_ORDERS_PER_CYCLE,
  DEX_INFO_RECHECK_MS,
  dexInfoMintsToAsk,
  nextDexPayment,
  pairHasTokenInfo,
  readDexInfoPayment,
} from "./dexInfo.js";

const SEC = 1_700_000_000;
const MS = SEC * 1000;

describe("readDexInfoPayment", () => {
  it("reads a token-profile payment in unix seconds, and does not invent a time", () => {
    expect(readDexInfoPayment([{ type: "tokenProfile", status: "approved", paymentTimestamp: SEC }])).toEqual(
      { type: "tokenProfile", updated: false, paidAtMs: MS },
    );
    expect(readDexInfoPayment([{ type: "tokenProfile", status: "approved" }])).toBeNull();
    expect(readDexInfoPayment([])).toBeNull();
    expect(readDexInfoPayment(null)).toBeNull();
  });

  it("calls a later token-info payment an update and keeps the newest time", () => {
    const body = {
      orders: [
        { type: "tokenProfile", status: "approved", paymentTimestamp: SEC },
        { type: "communityTakeover", status: "approved", paymentTimestamp: SEC + 3600 },
        { type: "tokenAd", status: "approved", paymentTimestamp: SEC + 7200 },
      ],
    };
    expect(readDexInfoPayment(body)).toEqual({
      type: "communityTakeover",
      updated: true,
      paidAtMs: (SEC + 3600) * 1000,
    });
  });

  it("ignores ads, boosts, cancelled and rejected orders", () => {
    expect(
      readDexInfoPayment([
        { type: "tokenAd", status: "approved", paymentTimestamp: SEC },
        { type: "trendingBarAd", status: "approved", paymentTimestamp: SEC },
        { type: "boost", status: "approved", paymentTimestamp: SEC },
        { type: "tokenProfile", status: "rejected", paymentTimestamp: SEC },
        { type: "tokenProfile", status: "cancelled", paymentTimestamp: SEC },
      ]),
    ).toBeNull();
  });

  it("counts a payment that is still processing, and a timestamp already in milliseconds", () => {
    expect(
      readDexInfoPayment([{ type: "tokenProfile", status: "processing", paymentTimestamp: MS }]),
    ).toEqual({ type: "tokenProfile", updated: false, paidAtMs: MS });
    expect(
      readDexInfoPayment([{ type: "communityTakeover", status: "on-hold", paymentTimestamp: String(SEC) }]),
    ).toEqual({ type: "communityTakeover", updated: false, paidAtMs: MS });
  });
});

describe("nextDexPayment", () => {
  it("keeps a missing read from becoming a payment, and drops a cancelled newest order", () => {
    expect(nextDexPayment(undefined)).toBeUndefined();
    expect(nextDexPayment(null)).toEqual({ paidAtMs: null, updated: false });
    const older = { type: "tokenProfile" as const, paidAtMs: MS, updated: false };
    expect(nextDexPayment(older)).toEqual({ paidAtMs: MS, updated: false });
    expect(nextDexPayment({ ...older, updated: true, paidAtMs: MS - 3_600_000 })).toEqual({
      paidAtMs: MS - 3_600_000,
      updated: true,
    });
  });
});

describe("pairHasTokenInfo", () => {
  it("is the pair info block, which carries no payment time", () => {
    expect(pairHasTokenInfo({ imageUrl: "https://cdn.dexscreener.com/x.png" })).toBe(true);
    expect(pairHasTokenInfo(undefined)).toBe(false);
    expect(pairHasTokenInfo(null)).toBe(false);
  });
});

describe("dexInfoMintsToAsk", () => {
  const now = 1_700_000_000_000;

  it("asks profile mints that are due, then backfill, and stops at the cycle cap", () => {
    const recent = new Date(now - 60_000);
    const stale = new Date(now - DEX_INFO_RECHECK_MS - 1);
    const ask = dexInfoMintsToAsk(
      ["fresh", "checked", "old"],
      [
        { mintAddress: "checked", dexInfoCheckedAt: recent },
        { mintAddress: "old", dexInfoCheckedAt: stale },
      ],
      ["back-a", "back-b", "fresh"],
      now,
    );
    expect(ask).toEqual(["fresh", "old", "back-a", "back-b"].slice(0, DEX_INFO_ORDERS_PER_CYCLE));
    expect(ask).toHaveLength(DEX_INFO_ORDERS_PER_CYCLE);
    expect(ask).not.toContain("checked");
  });
});
