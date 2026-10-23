import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiUsageMeter, type Env, type HeliusClient, type LargestHoldersResult } from "@trenchscanner/core";
import { takeHeliusStageCredits } from "./heliusStageCredits.js";
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

  it("puts the reads' billed Helius credits on the heartbeat's onChainHolders", async () => {
    takeHeliusStageCredits();
    const { helius } = fakeHelius(() => ({ status: "found", holders }));
    const read = helius.getLargestHoldersBatch.bind(helius);
    // What the metered fetch records for the read: a largest-accounts and a supply call per mint.
    helius.getLargestHoldersBatch = async (mints: string[]) => {
      apiUsageMeter.record(
        [
          {
            provider: "helius",
            endpoint: "getTokenLargestAccounts",
            calls: mints.length,
            credits: mints.length,
          },
        ],
        { requests: 1, ok: true, rateLimited: false, ms: 1 },
      );
      return read(mints);
    };
    await resolveOnChainHolders(["a", "b"], helius, env, 0);
    expect(takeHeliusStageCredits()).toEqual({ freshness: 0, balances: 0, onChainHolders: 2 });
    expect(takeHeliusStageCredits().onChainHolders).toBe(0);
  });

  it("re-reads a mint on its own shorter TTL (a young coin failing a holder cut)", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    const ttl = (mint: string) => (mint === "young" ? 1 : 5);
    await resolveOnChainHolders(["young", "old"], helius, env, 0, ttl);
    await resolveOnChainHolders(["young", "old"], helius, env, 90_000, ttl);
    expect(getLargestHoldersBatch.mock.calls.map((c) => c[0])).toEqual([["young", "old"], ["young"]]);
  });

  it("keeps a stale answer for a coin the trade stream says hasn't traded since (user decision 2026-10-20)", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    const lastTrade = { at: 0 };
    const quiet = (_mint: string, since: number) => lastTrade.at <= since;
    await resolveOnChainHolders(["q"], helius, env, 0, undefined, quiet);
    // Past the TTL but quiet: kept, as of now.
    expect((await resolveOnChainHolders(["q"], helius, env, 6 * 60_000, undefined, quiet)).get("q")).toBe(
      holders,
    );
    expect(getLargestHoldersBatch).toHaveBeenCalledTimes(1);
    // A trade since: read again once the TTL from the kept time runs out.
    lastTrade.at = 7 * 60_000;
    await resolveOnChainHolders(["q"], helius, env, 10 * 60_000, undefined, quiet);
    expect(getLargestHoldersBatch).toHaveBeenCalledTimes(1);
    await resolveOnChainHolders(["q"], helius, env, 11 * 60_000, undefined, quiet);
    expect(getLargestHoldersBatch).toHaveBeenCalledTimes(2);
  });

  it("backs off a mint whose read failed instead of asking every cycle", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "failed" }));
    expect((await resolveOnChainHolders(["a"], helius, env, 0)).size).toBe(0);
    await resolveOnChainHolders(["a"], helius, env, 30_000);
    expect(getLargestHoldersBatch).toHaveBeenCalledTimes(1);
  });

  it("asks the backup for the mints Helius didn't answer, even when Helius threw", async () => {
    const { helius } = fakeHelius((m) => (m === "a" ? { status: "found", holders } : { status: "failed" }));
    const backup = {
      holders: vi.fn(async (mints: readonly string[]) => new Map(mints.map((m) => [m, holders]))),
    };
    const out = await resolveOnChainHolders(["a", "b"], helius, env, 0, undefined, undefined, backup);
    expect(backup.holders).toHaveBeenCalledWith(["b"]);
    expect(out.get("b")).toEqual(holders);

    resetOnChainHolders();
    const throwing = {
      getLargestHoldersBatch: async () => {
        throw new Error("boom");
      },
    } as unknown as HeliusClient;
    expect(
      (await resolveOnChainHolders(["c"], throwing, env, 0, undefined, undefined, backup)).get("c"),
    ).toEqual(holders);
  });

  it("does nothing when switched off", async () => {
    const { helius, getLargestHoldersBatch } = fakeHelius(() => ({ status: "found", holders }));
    await resolveOnChainHolders(["a"], helius, { ...env, ONCHAIN_HOLDERS_MAX_PER_CYCLE: 0 }, 0);
    expect(getLargestHoldersBatch).not.toHaveBeenCalled();
  });
});
