import { describe, expect, it } from "vitest";
import { sinceText, solText, tallyTrades, type LiveTokenTrade } from "./liveTrades";

const trade = (
  seq: number,
  side: "buy" | "sell",
  sol: number,
  wallet: string,
  atMs: number,
): LiveTokenTrade => ({
  seq,
  sig: `s${seq}`,
  wallet,
  side,
  sol,
  tokens: 1,
  atMs,
  mcapUsd: null,
});

describe("live trades", () => {
  it("tallies the buys and sells since a moment", () => {
    const t = tallyTrades(
      [trade(1, "buy", 1, "a", 0), trade(2, "buy", 0.5, "b", 100), trade(3, "sell", 2, "a", 200)],
      50,
    );
    expect(t).toEqual({ buys: 1, sells: 1, solIn: 0.5, solOut: 2, traders: 2 });
  });

  it("writes SOL and ages short", () => {
    expect(solText(0.0004)).toBe("<0.001");
    expect(solText(0.0456)).toBe("0.046");
    expect(solText(1.234)).toBe("1.23");
    expect(solText(150.4)).toBe("150");
    expect(sinceText(1_000, 1_500)).toBe("now");
    expect(sinceText(0, 12_000)).toBe("12s");
    expect(sinceText(0, 4 * 60_000)).toBe("4m");
    expect(sinceText(0, 2 * 3_600_000)).toBe("2h");
  });
});
