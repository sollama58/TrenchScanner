import { describe, expect, it } from "vitest";
import { labelFigures, sideBotRows, type SideBotsResponse } from "./AdminSideBots";

const removal = (wallet: string, kolWallet: string, lastAt: string, held = true) => ({
  wallet,
  kolWallet,
  kolName: kolWallet === "kolA" ? "Alpha" : null,
  reason: "likelyBot" as const,
  held,
  pct: 100,
  shared: 10,
  kolCoins: 10,
  hours: 24,
  transfers: 0,
  firstAt: lastAt,
  lastAt,
});
const bot = (wallet: string, computedAt: string) => ({
  wallet,
  reason: "bot" as const,
  coins30d: 300,
  coinShare: 0.6,
  kols: [{ wallet: "kolB", name: "Bravo" }],
  removedLabels: 0,
  firstSeenAt: computedAt,
  computedAt,
});
const data: SideBotsResponse = {
  computedAt: null,
  rules: {
    bot: { minCoins: 200, minPct: 50, days: 30 },
    likelyBot: { minKols: 4, minPct: 60, minShared: 50, window: "7d" },
    holdDays: 90,
  },
  botCount: 2,
  removalCount: 3,
  bots: [bot("onlyBot", "2026-10-17T10:00:00Z"), bot("botAndRemoved", "2026-10-17T09:00:00Z")],
  removals: [
    removal("botAndRemoved", "kolA", "2026-10-17T11:00:00Z"),
    removal("botAndRemoved", "kolC", "2026-10-16T11:00:00Z", false),
    removal("onlyRemoved", "kolC", "2026-10-15T11:00:00Z"),
  ],
};

describe("Bots and removed sides", () => {
  it("folds a wallet's bot record and removed labels into one row, newest first", () => {
    const rows = sideBotRows(data, "all");
    expect(rows.map((r) => r.wallet)).toEqual(["botAndRemoved", "onlyBot", "onlyRemoved"]);
    expect(rows[0]!.removals).toHaveLength(2);
    expect(rows[0]!.lastAt).toBe("2026-10-17T11:00:00Z");
  });

  it("shows the bots, the removed sides, or the bots that lost a label", () => {
    expect(sideBotRows(data, "bots").map((r) => r.wallet)).toEqual(["botAndRemoved", "onlyBot"]);
    expect(sideBotRows(data, "removed").map((r) => r.wallet)).toEqual(["botAndRemoved", "onlyRemoved"]);
    expect(sideBotRows(data, "both").map((r) => r.wallet)).toEqual(["botAndRemoved"]);
  });

  it("searches by wallet and by a matched KOL's name or wallet", () => {
    expect(sideBotRows(data, "all", "ONLYREM").map((r) => r.wallet)).toEqual(["onlyRemoved"]);
    expect(sideBotRows(data, "all", "alpha").map((r) => r.wallet)).toEqual(["botAndRemoved"]);
    expect(sideBotRows(data, "all", "bravo").map((r) => r.wallet)).toEqual(["botAndRemoved", "onlyBot"]);
    expect(sideBotRows(data, "all", "kolc").map((r) => r.wallet)).toEqual(["botAndRemoved", "onlyRemoved"]);
  });

  it("says what earned the label it lost", () => {
    expect(labelFigures({ pct: 90, shared: 27, kolCoins: 30, hours: 48, transfers: 0 })).toBe(
      "90% of 30 coins in 48h",
    );
    expect(labelFigures({ pct: 0, shared: 0, kolCoins: 0, hours: 24, transfers: 8 })).toBe(
      "8 transfers in 24h",
    );
  });
});
