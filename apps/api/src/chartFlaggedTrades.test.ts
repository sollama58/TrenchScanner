import { describe, expect, it } from "vitest";
import { FlaggedTradeSaver, flaggedRows, type FlaggedTradeRow } from "./chartFlaggedTrades.js";
import type { LiveTokenTrade } from "./liveTrades.js";

const trade = (
  seq: number,
  wallet: string,
  sol: number | null,
  side: "buy" | "sell" = "buy",
): LiveTokenTrade => ({
  seq,
  sig: `s${seq}`,
  wallet,
  side,
  sol,
  tokens: 1,
  atMs: seq * 1_000,
  mcapUsd: null,
});

describe("flaggedRows", () => {
  it("keeps flagged wallets' and the creator's trades of a markable size", () => {
    const rows = flaggedRows(
      new Map([
        [
          "m",
          [trade(1, "kol", 1), trade(2, "kol", 0.01), trade(3, "nobody", 5), trade(4, "dev", null, "sell")],
        ],
      ]),
      new Set(["kol"]),
      new Map([["m", "dev"]]),
    );
    expect(rows.map((r) => [r.sig, r.side])).toEqual([
      ["s1", 1],
      ["s4", -1],
    ]);
  });
});

describe("FlaggedTradeSaver", () => {
  it("saves each followed coin's new flagged trades once", async () => {
    let trades = [trade(1, "kol", 1)];
    const saved: FlaggedTradeRow[] = [];
    const saver = new FlaggedTradeSaver(
      { followedMints: () => ["m"], recent: async () => ({ trades }) },
      {
        flagged: async () => ({ wallets: new Set(["kol"]), creators: new Map() }),
        save: async (rows) => void saved.push(...rows),
      },
    );
    expect(await saver.pass()).toBe(1);
    expect(await saver.pass()).toBe(0);
    trades = [...trades, trade(2, "kol", 2, "sell")];
    expect(await saver.pass()).toBe(1);
    expect(saved.map((r) => r.sig)).toEqual(["s1", "s2"]);
  });

  it("tries a failed save again on the next pass", async () => {
    let fail = true;
    const saved: FlaggedTradeRow[] = [];
    const saver = new FlaggedTradeSaver(
      { followedMints: () => ["m"], recent: async () => ({ trades: [trade(1, "kol", 1)] }) },
      {
        flagged: async () => ({ wallets: new Set(["kol"]), creators: new Map() }),
        save: async (rows) => {
          if (fail) throw new Error("down");
          saved.push(...rows);
        },
      },
    );
    expect(await saver.pass()).toBe(0);
    fail = false;
    expect(await saver.pass()).toBe(1);
    expect(saved).toHaveLength(1);
  });
});
