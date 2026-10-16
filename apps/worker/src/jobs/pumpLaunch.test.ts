import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PumpLaunchResult } from "@trenchscanner/core";
import { pumpLaunchBackupUrls, resetPumpLaunchState, resolvePumpLaunches } from "./pumpLaunch.js";

const launch = { quoteMint: "Q", pool: "P" };

describe("resolvePumpLaunches", () => {
  beforeEach(() => resetPumpLaunchState());

  it("reads each mint once: both answers are final", async () => {
    const getPumpLaunchBatch = vi.fn(
      async (mints: string[]) =>
        new Map<string, PumpLaunchResult>(
          mints.map((m) => [m, { status: "found", launch: m === "pump" ? launch : null }]),
        ),
    );
    const first = await resolvePumpLaunches(["pump", "other"], { getPumpLaunchBatch });
    expect(first.get("pump")).toEqual({ status: "found", launch });
    expect(first.get("other")).toEqual({ status: "found", launch: null });
    const again = await resolvePumpLaunches(["pump", "other"], { getPumpLaunchBatch });
    expect(again).toEqual(first);
    expect(getPumpLaunchBatch).toHaveBeenCalledTimes(1);
  });

  it("never remembers a failed read, and backs it off instead of asking every cycle", async () => {
    const now = Date.parse("2026-10-16T03:00:00Z");
    const getPumpLaunchBatch = vi.fn(async () => {
      throw new Error("rpc down");
    });
    expect((await resolvePumpLaunches(["m"], { getPumpLaunchBatch }, [], now)).get("m")).toEqual({
      status: "failed",
    });
    expect((await resolvePumpLaunches(["m"], { getPumpLaunchBatch }, [], now + 60_000)).has("m")).toBe(false);
    expect(getPumpLaunchBatch).toHaveBeenCalledTimes(1);

    const recovered = vi.fn(
      async () => new Map<string, PumpLaunchResult>([["m", { status: "found", launch }]]),
    );
    const later = await resolvePumpLaunches(["m"], { getPumpLaunchBatch: recovered }, [], now + 3 * 60_000);
    expect(later.get("m")).toEqual({ status: "found", launch });
  });

  it("asks the backups, in order, only for what Helius gave no answer for", async () => {
    const limited = vi.fn(async (mints: string[]) => {
      const out = new Map<string, PumpLaunchResult>(mints.map((m) => [m, { status: "failed" }]));
      out.set("ok", { status: "found", launch: null });
      out.set("young", { status: "failed", mintPending: true });
      return out;
    });
    const paidDown = vi.fn(async () => {
      throw new Error("429");
    });
    const publicRpc = vi.fn(
      async (mints: string[]) =>
        new Map<string, PumpLaunchResult>(mints.map((m) => [m, { status: "found", launch }])),
    );
    const result = await resolvePumpLaunches(["ok", "limited", "young"], { getPumpLaunchBatch: limited }, [
      { getPumpLaunchBatch: paidDown },
      { getPumpLaunchBatch: publicRpc },
    ]);
    expect(result.get("ok")).toEqual({ status: "found", launch: null });
    expect(result.get("limited")).toEqual({ status: "found", launch });
    expect(result.get("young")).toEqual({ status: "failed", mintPending: true });
    expect(paidDown).toHaveBeenCalledWith(["limited"]);
    expect(publicRpc).toHaveBeenCalledWith(["limited"]);
  });

  it("orders the backups paid first, each endpoint once", () => {
    expect(
      pumpLaunchBackupUrls({
        CHAIN_BACKUP_RPC_URLS: " https://a.example/k , https://b.example/k,",
        SOLANA_RPC_URL: "https://a.example/k",
        TRADING_BACKUP_RPC_URL: "",
      }),
    ).toEqual(["https://a.example/k", "https://b.example/k", "https://api.mainnet-beta.solana.com"]);
  });
});
