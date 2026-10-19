import { describe, expect, it } from "vitest";
import { LIVE_LAUNCH_BACKUP_MAX, LiveLaunchQuotes } from "./liveLaunchQuotes.js";
import type { TokenLookupOptions } from "../datasources/dexscreener.js";
import type { CandidateToken } from "../types.js";

const token = (
  mintAddress: string,
  priceUsd: number,
  extra: Partial<CandidateToken> = {},
): CandidateToken => ({
  mintAddress,
  priceUsd,
  marketCapUsd: priceUsd * 1e9,
  ...extra,
});

describe("LiveLaunchQuotes", () => {
  it("prices from Jupiter, and asks CoinGecko only for the launches Jupiter could not answer", async () => {
    const backupAsked: string[][] = [];
    const quotes = new LiveLaunchQuotes(
      {
        getLaunches: async (mints: string[], options?: TokenLookupOptions) => {
          // "failed" was in a batch that errored; "untraded" was answered without a price.
          options?.failed?.add("failed");
          return mints.filter((m) => m === "jupiter").map((m) => token(m, 0.00001));
        },
      },
      {
        getTokensByAddresses: async (mints: string[]) => {
          backupAsked.push(mints);
          // The backup's cap is taken as it is: GeckoTerminalClient puts it on the supply now.
          return [{ ...token("failed", 0.000012), marketCapUsd: 11_000, dexId: "pumpfun" }];
        },
      },
    );
    const got = await quotes.getLaunches(["jupiter", "failed", "untraded"], { deadlineMs: 5_000 });
    expect(backupAsked).toEqual([["failed"]]);
    expect(Object.fromEntries(got.map((t) => [t.mintAddress, t.marketCapUsd]))).toEqual({
      jupiter: 10_000,
      failed: 11_000,
    });
    expect(quotes.takeStats()).toEqual({ asked: 3, jupiter: 1, backupAsked: 1, backup: 1, unpriced: 0 });
    expect(quotes.takeStats().asked).toBe(0);
  });

  it("falls back to CoinGecko for every launch, newest first and capped, when Jupiter is down", async () => {
    let asked: string[] = [];
    const quotes = new LiveLaunchQuotes(
      {
        getLaunches: async () => {
          throw new Error("HTTP 429");
        },
      },
      {
        getTokensByAddresses: async (mints: string[]) => {
          asked = mints;
          return [token(mints[0]!, 0.00002)];
        },
      },
    );
    const mints = Array.from({ length: LIVE_LAUNCH_BACKUP_MAX + 10 }, (_, i) => `m${i}`);
    const got = await quotes.getLaunches(mints);
    expect(asked).toEqual(mints.slice(0, LIVE_LAUNCH_BACKUP_MAX));
    expect(got.map((t) => t.mintAddress)).toEqual(["m0"]);
    expect(quotes.takeStats()).toMatchObject({ jupiter: 0, backup: 1, unpriced: mints.length - 1 });
  });

  it("gives what Jupiter priced when the backup fails too", async () => {
    const quotes = new LiveLaunchQuotes(
      {
        getLaunches: async (_m: string[], options?: TokenLookupOptions) => {
          options?.failed?.add("b");
          return [token("a", 0.00001)];
        },
      },
      {
        getTokensByAddresses: async () => {
          throw new Error("down");
        },
      },
    );
    expect((await quotes.getLaunches(["a", "b"])).map((t) => t.mintAddress)).toEqual(["a"]);
    expect(quotes.takeStats()).toMatchObject({ unpriced: 1 });
  });
});
