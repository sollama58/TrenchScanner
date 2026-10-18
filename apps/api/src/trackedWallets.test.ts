import { describe, expect, it } from "vitest";
import { cleanTrackedName, mergeSides, TRACKED_NAME_MAX, withTrackedNames } from "./trackedWallets.js";

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
