import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStonksPoolLockState, resolveStonksPoolLocks } from "./stonksPoolLock.js";

const coin = { mintAddress: "Coin", pairAddress: "Pool" };
const now = Date.parse("2026-10-19T23:00:00Z");

describe("resolveStonksPoolLocks", () => {
  beforeEach(() => resetStonksPoolLockState());

  it("holds a locked pool for good: locked LP can't be unlocked", async () => {
    const getCpmmLpLockedBatch = vi.fn(async () => new Map<string, number | null | "failed">([["Pool", 1]]));
    expect(await resolveStonksPoolLocks([coin], { getCpmmLpLockedBatch }, now)).toEqual(new Set(["Coin"]));
    expect(await resolveStonksPoolLocks([coin], { getCpmmLpLockedBatch }, now + 3_600_000)).toEqual(
      new Set(["Coin"]),
    );
    expect(getCpmmLpLockedBatch).toHaveBeenCalledTimes(1);
    expect(getCpmmLpLockedBatch).toHaveBeenCalledWith(new Map([["Pool", "Coin"]]));
  });

  it("reads an unlocked or unknown pool again later, and backs off a failed read", async () => {
    const answers = new Map<string, number | null | "failed">([
      ["Pool", 0.4],
      ["Other", null],
      ["Down", "failed"],
    ]);
    const getCpmmLpLockedBatch = vi.fn(async () => answers);
    const coins = [
      coin,
      { mintAddress: "B", pairAddress: "Other" },
      { mintAddress: "C", pairAddress: "Down" },
    ];
    expect((await resolveStonksPoolLocks(coins, { getCpmmLpLockedBatch }, now)).size).toBe(0);
    expect((await resolveStonksPoolLocks(coins, { getCpmmLpLockedBatch }, now + 60_000)).size).toBe(0);
    expect(getCpmmLpLockedBatch).toHaveBeenCalledTimes(1);
    answers.set("Pool", 0.99);
    expect(await resolveStonksPoolLocks(coins, { getCpmmLpLockedBatch }, now + 11 * 60_000)).toEqual(
      new Set(["Coin"]),
    );
  });

  it("reads nothing as locked when the lookup throws", async () => {
    const getCpmmLpLockedBatch = vi.fn(async () => {
      throw new Error("rpc down");
    });
    expect((await resolveStonksPoolLocks([coin], { getCpmmLpLockedBatch }, now)).size).toBe(0);
  });
});
