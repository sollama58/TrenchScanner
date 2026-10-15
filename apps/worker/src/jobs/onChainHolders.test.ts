import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HeliusClient, LargestHoldersResult } from "@trenchscanner/core";
import { resetOnChainHolders, resolveOnChainHolders } from "./onChainHolders.js";

const env = { ONCHAIN_HOLDERS_MAX_PER_CYCLE: 2, RUGCHECK_CACHE_TTL_MINUTES: 5 } as Env;
const holders = { top10HolderPct: 20, top10HolderAddresses: ["w"] };

function fakeHelius(answer: (mint: string) => LargestHoldersResult) {
  const getLargestHoldersBatch = vi.fn(
    async (mints: string[]) => new Map(mints.map((m) => [m, answer(m)] as const)),
  );
  return { helius: { getLargestHoldersBatch } as unknown as HeliusClient, getLargestHoldersBatch };
}

describe("resolveOnChainHolders", () => {
  beforeEach(() => resetOnChainHolders());

  it("reads at most the cycle's budget and reuses answers within the cache window", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    const first = await resolveOnChainHolders(["a", "b", "c"], helius, env, 0);
    expect([...first.keys()]).toEqual(["a", "b"]);
    const second = await resolveOnChainHolders(["a", "b", "c"], helius, env, 60_000);
    expect([...second.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(getLargestHoldersBatch.mock.calls.map((c) => c[0])).toEqual([["a", "b"], ["c"]]);
  });

  it("re-reads a mint on its own shorter TTL (a young coin failing a holder cut)", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    const ttl = (mint: string) => (mint === "young" ? 1 : 5);
    await resolveOnChainHolders(["young", "old"], helius, env, 0, ttl);
    await resolveOnChainHolders(["young", "old"], helius, env, 90_000, ttl);
    expect(getLargestHoldersBatch.mock.calls.map((c) => c[0])).toEqual([["young", "old"], ["young"]]);
  });

  it("backs off a mint whose read failed instead of asking every cycle", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "failed" }));
    expect((await resolveOnChainHolders(["a"], helius, env, 0)).size).toBe(0);
    await resolveOnChainHolders(["a"], helius, env, 30_000);
    expect(getLargestHoldersBatch).toHaveBeenCalledTimes(1);
  });

  it("does nothing when switched off", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    await resolveOnChainHolders(["a"], helius, { ...env, ONCHAIN_HOLDERS_MAX_PER_CYCLE: 0 }, 0);
    expect(getLargestHoldersBatch).not.toHaveBeenCalled();
  });
});
