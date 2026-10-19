import { describe, expect, it } from "vitest";
import type { CurveState } from "@trenchscanner/core";
import { ChartHealth } from "./chartHealth.js";
import { chartBackupRpcUrl, withBackupRoute, type ChartReader } from "./chartRpc.js";

const state: CurveState = {
  virtualToken: 1e15,
  virtualQuote: 5e10,
  realQuote: 0,
  complete: false,
  quoteIsSol: true,
};

/** A reader that answers every key, but fails the keys in `fails`; records what it was asked. */
function reader(fails: Set<string>, asked: string[][]): ChartReader {
  const batch = <V>(keys: string[], v: V) => {
    asked.push(keys);
    return new Map<string, V | "failed">(keys.map((k) => [k, fails.has(k) ? "failed" : v]));
  };
  return {
    getCurveStatesBatch: async (keys) => batch(keys, state as CurveState | null),
    getTokenAmountsBatch: async (keys) => batch(keys, 7 as number | null),
    getPoolVaultsBatch: async (pools) =>
      batch([...pools.keys()], { base: "b", quote: "q", virtualQuote: 0 } as never),
    findLaunchLabPool: async (mint) => (fails.has(mint) ? "failed" : "pool-" + mint),
    findCpmmPoolVaults: async (mint) => (fails.has(mint) ? "failed" : null),
  };
}

describe("chartBackupRpcUrl", () => {
  it("is SOLANA_RPC_URL only when it is set and isn't the Helius key's own endpoint", () => {
    expect(chartBackupRpcUrl("", "key")).toBeNull();
    expect(chartBackupRpcUrl(undefined, "key")).toBeNull();
    expect(chartBackupRpcUrl("https://mainnet.helius-rpc.com/?api-key=key", "key")).toBeNull();
    expect(chartBackupRpcUrl(" https://rpc.example.com ", "key")).toBe("https://rpc.example.com");
    expect(chartBackupRpcUrl("https://rpc.example.com", undefined)).toBe("https://rpc.example.com");
  });
});

describe("withBackupRoute", () => {
  it("asks the backup only for what Helius failed, and counts both", async () => {
    const health = new ChartHealth(Date.now, () => ({}));
    const primaryAsked: string[][] = [];
    const backupAsked: string[][] = [];
    const r = withBackupRoute(
      reader(new Set(["c2", "c3"]), primaryAsked),
      reader(new Set(["c3"]), backupAsked),
      health,
    );
    const out = await r.getCurveStatesBatch(["c1", "c2", "c3", "c1"]);
    expect(primaryAsked).toEqual([["c1", "c2", "c3"]]);
    expect(backupAsked).toEqual([["c2", "c3"]]);
    expect(out.get("c1")).toEqual(state);
    expect(out.get("c2")).toEqual(state);
    expect(out.get("c3")).toBe("failed");
    expect(health.snapshot().rpc).toEqual({ heliusFailures: 2, backupReads: 2, backupFailures: 1 });
  });

  it("leaves the backup alone when Helius answered everything, and works without one", async () => {
    const backupAsked: string[][] = [];
    const healthy = withBackupRoute(reader(new Set(), []), reader(new Set(), backupAsked), new ChartHealth());
    await healthy.getTokenAmountsBatch(["v1", "v2"]);
    await healthy.getPoolVaultsBatch(new Map([["p1", { mint: "m", quoteMint: "q" }]]));
    expect(backupAsked).toEqual([]);
    const alone = withBackupRoute(reader(new Set(["v1"]), []), null, new ChartHealth());
    expect((await alone.getTokenAmountsBatch(["v1"])).get("v1")).toBe("failed");
  });

  it("retries a failed pool scan once on the backup", async () => {
    const r = withBackupRoute(reader(new Set(["m1"]), []), reader(new Set(), []), new ChartHealth());
    expect(await r.findLaunchLabPool("m1")).toBe("pool-m1");
    expect(await r.findCpmmPoolVaults("m1", "q")).toBeNull();
  });

  it("treats a reader that throws as a failed read", async () => {
    const broken = reader(new Set(), []);
    broken.getCurveStatesBatch = async () => {
      throw new Error("socket hang up");
    };
    const r = withBackupRoute(broken, reader(new Set(), []), new ChartHealth());
    expect((await r.getCurveStatesBatch(["c1"])).get("c1")).toEqual(state);
  });
});
