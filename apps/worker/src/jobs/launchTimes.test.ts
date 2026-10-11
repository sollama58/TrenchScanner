import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@trenchscanner/core";
import { rememberLaunchTimes, resetLaunchTimes, resolvePreBondSeconds } from "./launchTimes.js";

const env = { SAFETY_MIN_PREBOND_SECONDS: 10, PREBOND_LOOKUPS_MAX_PER_CYCLE: 5 } as Env;
const GRAD = new Date(1_791_674_763_000);

describe("resolvePreBondSeconds", () => {
  beforeEach(() => resetLaunchTimes());

  it("measures launch to graduation from a launch time discovery already carried", async () => {
    rememberLaunchTimes([{ mintAddress: "a", createdAt: new Date(GRAD.getTime() - 3_000) }]);
    const launchTime = vi.fn();
    const out = await resolvePreBondSeconds(
      [{ mintAddress: "a", graduatedAt: GRAD }],
      new Map(),
      { launchTime },
      env,
    );
    expect(out.get("a")).toBe(3);
    expect(launchTime).not.toHaveBeenCalled();
  });

  it("skips the lookup for a mint known a full floor before it graduated, and for one on its curve", async () => {
    const launchTime = vi.fn();
    const out = await resolvePreBondSeconds(
      [{ mintAddress: "old", graduatedAt: GRAD }, { mintAddress: "curve" }],
      new Map([["old", new Date(GRAD.getTime() - 60_000)]]),
      { launchTime },
      env,
    );
    expect(out.size).toBe(0);
    expect(launchTime).not.toHaveBeenCalled();
  });

  it("asks Pump.fun once for a mint first seen at or after graduation, and keeps the answer", async () => {
    const launchTime = vi.fn().mockResolvedValue(new Date(GRAD.getTime()));
    const known = new Map([["b", new Date(GRAD.getTime() + 30_000)]]);
    const first = await resolvePreBondSeconds(
      [{ mintAddress: "b", graduatedAt: GRAD }],
      known,
      { launchTime },
      env,
    );
    const again = await resolvePreBondSeconds(
      [{ mintAddress: "b", graduatedAt: GRAD }],
      known,
      { launchTime },
      env,
    );
    expect(first.get("b")).toBe(0);
    expect(again.get("b")).toBe(0);
    expect(launchTime).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed or missing launch time unknown, and stays within the cycle budget", async () => {
    const launchTime = vi.fn(async (mint: string) => {
      if (mint === "fail") throw new Error("down");
      return null;
    });
    const candidates = ["fail", "none", "c", "d", "e", "f", "g"].map((mintAddress) => ({
      mintAddress,
      graduatedAt: GRAD,
    }));
    const out = await resolvePreBondSeconds(candidates, new Map(), { launchTime }, env);
    expect(out.size).toBe(0);
    expect(launchTime).toHaveBeenCalledTimes(5);
  });

  it("does nothing with the cut off", async () => {
    rememberLaunchTimes([{ mintAddress: "a", createdAt: GRAD }]);
    const out = await resolvePreBondSeconds(
      [{ mintAddress: "a", graduatedAt: GRAD }],
      new Map(),
      { launchTime: vi.fn() },
      { ...env, SAFETY_MIN_PREBOND_SECONDS: 0 },
    );
    expect(out.size).toBe(0);
  });
});
