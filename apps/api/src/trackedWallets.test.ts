import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@trenchscanner/core";
import type { Env } from "@trenchscanner/core";
import {
  activeTracked,
  cleanTrackedName,
  mergeSides,
  resetTrackedCache,
  TRACKED_NAME_MAX,
  withTrackedNames,
} from "./trackedWallets.js";

describe("cleanTrackedName", () => {
  it("drops control and zero-width characters, folds spaces and holds the length", () => {
    expect(cleanTrackedName(" Big​\u0007  Fish\n")).toBe("Big Fish");
    expect(cleanTrackedName("​ \t")).toBeNull();
    expect([...cleanTrackedName("🐋".repeat(50))!]).toHaveLength(TRACKED_NAME_MAX);
  });
});

describe("withTrackedNames", () => {
  const t = [{ wallet: "A", name: "Mine", category: "tracked" as const }];
  it("names only the asked wallets the reader labeled, over any other name", () => {
    expect(withTrackedNames({ A: { name: "Helius", source: "identity" } }, t, ["A", "B"])).toEqual({
      A: { name: "Mine", source: "tracked", mine: true },
    });
    expect(withTrackedNames({}, t, ["B"])).toEqual({});
  });
});

describe("mergeSides", () => {
  const side = { kolWallet: "K", kolName: "Roster", pct: 50, shared: 5, kolCoins: 10, hours: 24 };
  it("keeps the roster's tie first and renames it to the reader's label of that KOL", () => {
    const out = mergeSides(
      { W: [side] },
      {
        W: [
          { ...side, kolWallet: "K", tracked: "kol" },
          { ...side, kolWallet: "T", tracked: "tracked" },
        ],
      },
      [{ wallet: "K", name: "My KOL", category: "kol" }],
    );
    expect(out.W!.map((s) => [s.kolWallet, s.kolName, s.tracked])).toEqual([
      ["K", "My KOL", "kol"],
      ["T", "Roster", "tracked"],
    ]);
  });
});

describe("activeTracked", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTrackedCache();
  });

  it("reads a failed lookup as no labels without keeping it, so the next read asks again", async () => {
    const env = { PRO_TRADING_ENABLED: true } as Env;
    const user = { userId: "u1", walletAddress: "W" };
    const find = vi
      .spyOn(prisma.userTrackedWallet, "findMany")
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce([]);
    expect(await activeTracked(env, user, 1_000)).toEqual([]);
    expect(await activeTracked(env, user, 2_000)).toEqual([]);
    expect(find).toHaveBeenCalledTimes(2);
    // A good answer is kept for the minute.
    expect(await activeTracked(env, user, 3_000)).toEqual([]);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
