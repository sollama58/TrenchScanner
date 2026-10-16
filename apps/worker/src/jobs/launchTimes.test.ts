import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@trenchscanner/core";
import {
  rememberGraduations,
  rememberLaunchTimes,
  resetLaunchTimes,
  resolveLaunchTimes,
  resolvePreBondSeconds,
} from "./launchTimes.js";

const env = {
  SAFETY_MIN_PREBOND_SECONDS: 5,
  PREBOND_LOOKUPS_MAX_PER_CYCLE: 5,
  LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE: 3,
} as Env;
const GRAD = new Date(1_791_674_763_000);

function clients(launchTime = vi.fn(), pumpSwapGraduation = vi.fn()) {
  return { pumpFun: { launchTime }, dexScreener: { pumpSwapGraduation } };
}

describe("resolvePreBondSeconds", () => {
  beforeEach(() => resetLaunchTimes());

  it("measures launch to graduation from a launch time discovery already carried", async () => {
    rememberLaunchTimes([{ mintAddress: "a", createdAt: new Date(GRAD.getTime() - 3_000) }]);
    const c = clients();
    const out = await resolvePreBondSeconds([{ mintAddress: "a", graduatedAt: GRAD }], new Map(), c, env);
    expect(out.get("a")).toBe(3);
    expect(c.pumpFun.launchTime).not.toHaveBeenCalled();
  });

  it("skips the lookup for a mint known a full floor before it graduated, and for one on its curve", async () => {
    const c = clients();
    const out = await resolvePreBondSeconds(
      [
        { mintAddress: "old", graduatedAt: GRAD },
        { mintAddress: "curve", dexId: "pumpfun", buys24h: 40, sells24h: 12 },
      ],
      new Map([["old", new Date(GRAD.getTime() - 60_000)]]),
      c,
      env,
    );
    expect(out.size).toBe(0);
    expect(c.pumpFun.launchTime).not.toHaveBeenCalled();
    expect(c.dexScreener.pumpSwapGraduation).not.toHaveBeenCalled();
  });

  it("asks Pump.fun once for a mint first seen at or after graduation, and keeps the answer", async () => {
    const c = clients(vi.fn().mockResolvedValue(new Date(GRAD.getTime())));
    const known = new Map([["b", new Date(GRAD.getTime() + 30_000)]]);
    const first = await resolvePreBondSeconds([{ mintAddress: "b", graduatedAt: GRAD }], known, c, env);
    const again = await resolvePreBondSeconds([{ mintAddress: "b", graduatedAt: GRAD }], known, c, env);
    expect(first.get("b")).toBe(0);
    expect(again.get("b")).toBe(0);
    expect(c.pumpFun.launchTime).toHaveBeenCalledTimes(1);
  });

  it("leaves a failed or missing launch time unknown, and stays within the cycle budget", async () => {
    const c = clients(
      vi.fn(async (mint: string) => {
        if (mint === "fail") throw new Error("down");
        return null;
      }),
    );
    const candidates = ["fail", "none", "c", "d", "e", "f", "g"].map((mintAddress) => ({
      mintAddress,
      graduatedAt: GRAD,
    }));
    const out = await resolvePreBondSeconds(candidates, new Map(), c, env);
    expect(out.size).toBe(0);
    expect(c.pumpFun.launchTime).toHaveBeenCalledTimes(5);
  });

  it("catches a coin bonded in its launch second that DexScreener's batch still shows on its frozen curve", async () => {
    // DOWO, 2026-10-12: /tokens/v1 listed only the curve (5 buys, no sells) at the graduation
    // price; the pool, created the same second as the coin, was on /token-pairs only.
    const curve = {
      mintAddress: "dowo",
      dexId: "pumpfun",
      pairCreatedAt: GRAD,
      buys24h: 5,
      sells24h: 0,
    };
    const c = clients(vi.fn(), vi.fn().mockResolvedValue(GRAD));
    const out = await resolvePreBondSeconds([curve], new Map(), c, env);
    expect(out.get("dowo")).toBe(0);
    expect(c.pumpFun.launchTime).not.toHaveBeenCalled();
  });

  it("asks again later when no pool is listed yet, rather than settling for good", async () => {
    const curve = { mintAddress: "x", dexId: "pumpfun", pairCreatedAt: GRAD, buys24h: 3, sells24h: 0 };
    const pool = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Date(GRAD.getTime() + 2_000));
    const c = clients(vi.fn(), pool);
    expect((await resolvePreBondSeconds([curve], new Map(), c, env, 0)).size).toBe(0);
    expect((await resolvePreBondSeconds([curve], new Map(), c, env, 60_000)).size).toBe(0);
    const later = await resolvePreBondSeconds([curve], new Map(), c, env, 4 * 60_000);
    expect(later.get("x")).toBe(2);
    expect(pool).toHaveBeenCalledTimes(2);
  });

  it("takes graduation from the stream's migration event", async () => {
    rememberGraduations([{ mintAddress: "m", at: new Date(GRAD.getTime() + 1_000) }]);
    const c = clients();
    const out = await resolvePreBondSeconds(
      [{ mintAddress: "m", dexId: "pumpfun", pairCreatedAt: GRAD, buys24h: 5, sells24h: 0 }],
      new Map(),
      c,
      env,
    );
    expect(out.get("m")).toBe(1);
    expect(c.dexScreener.pumpSwapGraduation).not.toHaveBeenCalled();
  });

  it("does nothing with the cut off", async () => {
    rememberLaunchTimes([{ mintAddress: "a", createdAt: GRAD }]);
    const out = await resolvePreBondSeconds([{ mintAddress: "a", graduatedAt: GRAD }], new Map(), clients(), {
      ...env,
      SAFETY_MIN_PREBOND_SECONDS: 0,
    });
    expect(out.size).toBe(0);
  });
});

describe("resolveLaunchTimes", () => {
  beforeEach(() => resetLaunchTimes());
  const LAUNCH = new Date(GRAD.getTime() - 3_600_000);
  const graduate = (mintAddress: string) => ({ mintAddress, dexId: "pumpswap", pairCreatedAt: GRAD });
  const launchTimeOf = (answers: Record<string, Date | null | Error>) =>
    vi.fn(async (mint: string) => {
      const a = answers[mint];
      if (a instanceof Error) throw a;
      return a ?? null;
    });

  it("answers from the Token row and the curve pair without a lookup, and seeds the pre-bond cut", async () => {
    const launchTime = launchTimeOf({});
    const store = vi.fn().mockResolvedValue(undefined);
    const { known, pending } = resolveLaunchTimes(
      [graduate("row"), { mintAddress: "curve", dexId: "pumpfun", pairCreatedAt: LAUNCH }],
      new Map([["row", LAUNCH]]),
      { pumpFun: { launchTime } },
      env,
      store,
    );
    await pending;
    expect(known.get("row")).toEqual(LAUNCH);
    expect(known.get("curve")).toEqual(LAUNCH);
    expect(launchTime).not.toHaveBeenCalled();
    // The row already has its own; the curve coin's lands on the row once.
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith("curve", LAUNCH);
    const preBond = await resolvePreBondSeconds(
      [{ mintAddress: "row", graduatedAt: GRAD }],
      new Map(),
      { pumpFun: { launchTime }, dexScreener: { pumpSwapGraduation: vi.fn() } },
      env,
    );
    expect(preBond.get("row")).toBe(3600);
  });

  it("asks Pump.fun once for a graduate nobody has a launch time for, behind the cycle, and keeps the answer on the row", async () => {
    const launchTime = launchTimeOf({ g: LAUNCH });
    const store = vi.fn().mockResolvedValue(undefined);
    const clients = { pumpFun: { launchTime } };
    const first = resolveLaunchTimes([graduate("g")], new Map([["g", null]]), clients, env, store);
    // Unknown this cycle: the age counts from the pool until the answer lands.
    expect(first.known.has("g")).toBe(false);
    // Asked again before the answer lands, it is not asked twice.
    const again = resolveLaunchTimes([graduate("g")], new Map([["g", null]]), clients, env, store);
    await Promise.all([first.pending, again.pending]);
    expect(launchTime).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith("g", LAUNCH);
    // Next cycle: known from memory, nothing asked or written again.
    const next = resolveLaunchTimes([graduate("g")], new Map([["g", null]]), clients, env, store);
    await next.pending;
    expect(next.known.get("g")).toEqual(LAUNCH);
    expect(launchTime).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("asks only about graduated Pump.fun coins, within the cycle budget", async () => {
    const launchTime = launchTimeOf({});
    const { pending } = resolveLaunchTimes(
      [
        { mintAddress: "curve-no-pair", dexId: "pumpfun" },
        { mintAddress: "unlisted" },
        { mintAddress: "stonks", dexId: "raydium", launchpad: "stonks" },
        graduate("a"),
        graduate("b"),
        graduate("c"),
        graduate("d"),
      ],
      new Map(),
      { pumpFun: { launchTime } },
      env,
      vi.fn(),
    );
    await pending;
    expect(launchTime.mock.calls.map(([mint]) => mint).sort()).toEqual(["a", "b", "c"]);
  });

  it("backs off a failed lookup and settles Pump.fun's no-such-coin for the process", async () => {
    const launchTime = launchTimeOf({ fail: new Error("down"), none: null });
    const clients = { pumpFun: { launchTime } };
    const store = vi.fn();
    const candidates = [graduate("fail"), graduate("none")];
    await resolveLaunchTimes(candidates, new Map(), clients, env, store, 0).pending;
    expect(launchTime).toHaveBeenCalledTimes(2);
    expect(store).not.toHaveBeenCalled();
    // A minute on: the failure is still backed off, the empty answer is kept.
    await resolveLaunchTimes(candidates, new Map(), clients, env, store, 60_000).pending;
    expect(launchTime).toHaveBeenCalledTimes(2);
    // Past the back-off only the failed one is asked again.
    await resolveLaunchTimes(candidates, new Map(), clients, env, store, 3 * 60_000).pending;
    expect(launchTime).toHaveBeenCalledTimes(3);
    expect(launchTime).toHaveBeenLastCalledWith("fail");
  });

  it("does nothing with the lookups off", async () => {
    const launchTime = launchTimeOf({ g: LAUNCH });
    const { known, pending } = resolveLaunchTimes(
      [graduate("g")],
      new Map(),
      { pumpFun: { launchTime } },
      { LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE: 0 },
      vi.fn(),
    );
    await pending;
    expect(known.size).toBe(0);
    expect(launchTime).not.toHaveBeenCalled();
  });
});
